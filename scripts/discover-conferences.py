#!/usr/bin/env python3
"""Bounded public-page discovery. No dependencies, private-file outputs, or automatic approvals."""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import hashlib
import html
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

UTC = dt.timezone.utc
AGENT = "CoreConferenceDiscovery"
USER_AGENT = AGENT + "/1.0 (public event monitoring; respects robots.txt)"
MAX_PAGES_PER_WATCH = 8
MAX_PAGES_PER_RUN = 512
MAX_CANDIDATES = 500
MAX_CANDIDATE_BYTES = 9 * 1024 * 1024  # Reserve space below the RPC's 10 MiB limit.
MAX_BYTES = 2 * 1024 * 1024
RUN_SECONDS = 1200
TIMEOUT = 8
REQUEST_SECONDS = 20
EVENT_WORDS = re.compile(r"\b(conference|convention|summit|symposium|expo|workshop|seminar|annual meeting|golf|fundraiser|banquet|training|institute)\b", re.I)
LINK_WORDS = re.compile(r"conference|convention|summit|symposium|expo|calendar|events?|sponsor|annual.meeting|workshop|seminar|golf", re.I)
LISTING_TITLE = re.compile(r"^(?:upcoming\s+)?(?:events?|conferences?|calendar|home|news)(?:\s*[|:–—-].*)?$", re.I)
EVENT_TYPES = {"Event", "BusinessEvent", "EducationEvent", "ExhibitionEvent", "SocialEvent"}
STOP_WORDS = {"the", "of", "and", "for", "in", "to", "a", "an", "annual", "conference", "conferences", "event", "events", "calendar", "upcoming", "sponsorship", "sponsorships", "meeting", "meetings"}


class DiscoveryError(Exception):
    """Only fixed, non-private error codes may reach logs."""


def stamp(now=None):
    return (now or dt.datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(UTC)
    except (ValueError, TypeError):
        raise DiscoveryError("invalid_schedule_timestamp") from None


def is_due(settings, now, force=False):
    if not settings.get("enabled"):
        return False
    if settings.get("intervalDays") != 14:
        raise DiscoveryError("schedule_must_be_fourteen_days")
    if force:
        return True
    if settings.get("nextRunAt"):
        return now >= timestamp(settings["nextRunAt"])
    if settings.get("lastRunAt"):
        return now >= timestamp(settings["lastRunAt"]) + dt.timedelta(days=14)
    return True


def clean(value, limit=4000):
    if not isinstance(value, (str, int, float)):
        return ""
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value)))).replace("\x00", "").strip()
    # Browser validation counts UTF-16 units, rather than Python code points.
    # Decode after cutting so an astral character cannot leave a lone surrogate;
    # invalid source surrogates are dropped too. PostgreSQL jsonb rejects NUL.
    return text.encode("utf-16-le", "surrogatepass")[:max(0, limit) * 2].decode("utf-16-le", "ignore")


def canonical_url(url):
    """Reject credentials, non-web protocols, odd ports, and ambiguous host syntax."""
    if not isinstance(url, str) or len(url) > 2000 or re.search(r"[\x00-\x20\\]", url):
        raise DiscoveryError("invalid_public_url")
    try:
        p = urlsplit(url)
        if p.scheme.lower() not in {"http", "https"} or not p.hostname or p.username is not None or p.password is not None:
            raise ValueError()
        host = p.hostname.rstrip(".").encode("idna").decode("ascii").lower()
        if "%" in host or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
            raise ValueError()
        port = p.port or (443 if p.scheme.lower() == "https" else 80)
        if port != (443 if p.scheme.lower() == "https" else 80):
            raise ValueError()
        netloc = "[" + host + "]" if ":" in host else host
        pairs = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.lower().startswith("utm_") and k.lower() not in {"gclid", "fbclid", "msclkid"}]
        path = quote(p.path or "/", safe="/%:@!$&'()*+,;=-._~")
        normalized = urlunsplit((p.scheme.lower(), netloc, path, urlencode(sorted(pairs)), ""))
        if len(normalized) > 2000:
            raise ValueError()
        return normalized
    except (ValueError, UnicodeError):
        raise DiscoveryError("invalid_public_url") from None


def origin(url):
    p = urlsplit(canonical_url(url))
    return p.scheme + "://" + p.netloc


def public_addresses(url, resolver=socket.getaddrinfo):
    p = urlsplit(canonical_url(url))
    port = 443 if p.scheme == "https" else 80
    try:
        records = resolver(p.hostname, port, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(r[4][0] for r in records))
        if not addresses:
            raise DiscoveryError("dns_unavailable")
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global or ip.is_multicast or ip.is_unspecified or (isinstance(ip, ipaddress.IPv6Address) and (ip.ipv4_mapped or ip.sixtofour or ip.teredo)):
                raise DiscoveryError("nonpublic_destination_blocked")
        return addresses
    except (OSError, ValueError):
        raise DiscoveryError("dns_unavailable") from None


@dataclass
class Response:
    url: str
    status: int
    headers: dict
    body: bytes


def transport(url, address, headers, method="GET", body=None, limit=MAX_BYTES):
    """Connect to the checked IP, preserving the original TLS hostname and Host header.

    This avoids a second DNS lookup between validation and connection. Proxy environment
    variables, cookies, and automatic redirects are deliberately not used.
    """
    p = urlsplit(url)
    port = 443 if p.scheme == "https" else 80
    connection = http.client.HTTPConnection(p.hostname, port, timeout=TIMEOUT)
    sock = None
    timer = None
    deadline = time.monotonic() + REQUEST_SECONDS
    try:
        sock = socket.create_connection((address, port), timeout=TIMEOUT)
        if p.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=p.hostname)
        def expire():
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(max(0.001, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        connection.sock = sock
        connection.request(method, p.path + ("?" + p.query if p.query else ""), body=body, headers={"Host": p.netloc, **headers})
        result = connection.getresponse()
        response_headers = {k.lower(): v for k, v in result.getheaders()}
        if response_headers.get("content-encoding", "identity").lower() not in {"identity", ""}:
            raise DiscoveryError("encoded_response_not_supported")
        content = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DiscoveryError("request_time_limit")
            sock.settimeout(min(TIMEOUT, remaining))
            # read1 returns after one buffered/network read, so a slow stream cannot
            # postpone the total wall-clock deadline by continually sending tiny chunks.
            chunk = result.read1(min(65536, limit + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > limit:
                raise DiscoveryError("response_size_limit")
        return Response(url, result.status, response_headers, bytes(content))
    except (OSError, http.client.HTTPException, ssl.SSLError):
        raise DiscoveryError("public_fetch_failed") from None
    finally:
        if timer is not None:
            timer.cancel()
        connection.close()
        if sock is not None:
            sock.close()


class Robots:
    """Conservative robots policy with longest-match Allow/Disallow and * / $ support."""
    def __init__(self, text="", deny=False):
        self.deny = deny
        self.rules = []
        self.delay = 0.5
        groups, agents, rules, delay, has_directive = [], [], [], 0.5, False
        for line in text.splitlines() + ["User-agent: __end__"]:
            line = line.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (s.strip() for s in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if has_directive:
                    groups.append((agents, rules, delay))
                    agents, rules, delay, has_directive = [], [], 0.5, False
                agents.append(value.lower())
            elif agents and key in {"allow", "disallow"}:
                has_directive = True
                if value:
                    rules.append((key == "allow", value))
            elif agents and key == "crawl-delay":
                has_directive = True
                try:
                    delay = max(0.5, float(value))
                except ValueError:
                    pass
        matched = [(max((len(a) if a != "*" else 0) for a in names if a == "*" or a in AGENT.lower()), rs, d) for names, rs, d in groups if any(a == "*" or a in AGENT.lower() for a in names)]
        if matched:
            score = max(v[0] for v in matched)
            for rank, rs, d in matched:
                if rank == score:
                    self.rules.extend(rs)
                    self.delay = max(self.delay, d)

    def allowed(self, url):
        if self.deny or self.delay > 10:
            return False
        p = urlsplit(url)
        def normalized(value):
            value = quote(value, safe="/%?&=:@!$'()*+,;~-._")
            return re.sub(r"%([0-9a-fA-F]{2})", lambda m: chr(int(m[1], 16)) if re.fullmatch(r"[a-zA-Z0-9._~-]", chr(int(m[1], 16))) else "%" + m[1].upper(), value)
        target = normalized(p.path + ("?" + p.query if p.query else ""))
        matches = []
        for allow, pattern in self.rules:
            end = pattern.endswith("$")
            source = normalized(pattern[:-1] if end else pattern)
            regex = "^" + ".*".join(re.escape(x) for x in source.split("*")) + ("$" if end else "")
            if re.search(regex, target):
                matches.append((len(source.replace("*", "")), allow))
        return max(matches)[1] if matches else True


class PublicFetcher:
    def __init__(self, resolver=socket.getaddrinfo, send=transport, pause=time.sleep):
        self.resolver, self.send, self.pause = resolver, send, pause
        self.robots_cache = {}
        self.next_request = {}
        self.lock = threading.Lock()

    def _once(self, url, headers=None, method="GET", body=None, limit=MAX_BYTES, delay=0.5):
        url = canonical_url(url)
        addresses = public_addresses(url, self.resolver)
        host = urlsplit(url).hostname
        with self.lock:
            wait = max(0, self.next_request.get(host, 0) - time.monotonic())
            self.next_request[host] = time.monotonic() + wait + delay
        self.pause(wait)
        return self.send(url, addresses[0], {"User-Agent": USER_AGENT, "Accept-Encoding": "identity", "Accept": "text/html,application/ld+json,application/pdf,text/plain;q=0.8", **(headers or {})}, method, body, limit)

    def policy(self, url):
        base = origin(url)
        with self.lock:
            cached = self.robots_cache.get(base)
        if cached is not None:
            return cached
        try:
            target = base + "/robots.txt"
            for _ in range(5):
                r = self._once(target, limit=256 * 1024)
                if r.status in {301, 302, 303, 307, 308}:
                    target = canonical_url(urljoin(r.url, r.headers.get("location", "")))
                    continue
                break
            if r.status in {404, 410}:
                policy = Robots()
            elif r.status == 200 and not r.body.lstrip().lower().startswith((b"<!doctype html", b"<html")):
                policy = Robots(r.body.decode("utf-8", "replace"))
            else:
                policy = Robots(deny=True)
        except DiscoveryError:
            policy = Robots(deny=True)
        with self.lock:
            self.robots_cache[base] = policy
        return policy

    def get(self, url):
        target = canonical_url(url)
        for _ in range(5):
            # Each target, including every redirect, has fresh public DNS validation and robots checks.
            public_addresses(target, self.resolver)
            policy = self.policy(target)
            if not policy.allowed(target):
                raise DiscoveryError("robots_denied_or_unavailable")
            r = self._once(target, delay=policy.delay)
            if r.status not in {301, 302, 303, 307, 308}:
                return r
            if not r.headers.get("location"):
                raise DiscoveryError("invalid_redirect")
            target = canonical_url(urljoin(target, r.headers["location"]))
        raise DiscoveryError("redirect_limit")


class EventHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.headings, self.links, self.jsonld = [], [], [], []
        self.page_title = ""
        self.skip = 0
        self.script = None
        self.capture = None
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script":
            self.script = [] if a.get("type", "").lower().split(";")[0] == "application/ld+json" else None
            self.skip += 1
        elif tag in {"style", "noscript", "template"}:
            self.skip += 1
        elif not self.skip:
            if tag in {"p", "li", "div", "section", "article", "br", "h1", "h2", "h3", "dt", "dd"}:
                self.parts.append("\n")
            if tag in {"title", "h1", "h2", "h3"}:
                self.capture = (tag, [])
            if tag == "a" and a.get("href"):
                self.anchor = (a["href"], [])

    def handle_endtag(self, tag):
        if tag == "script":
            if self.script is not None:
                self.jsonld.append("".join(self.script))
            self.script = None
            self.skip = max(0, self.skip - 1)
        elif tag in {"style", "noscript", "template"}:
            self.skip = max(0, self.skip - 1)
        elif not self.skip:
            if self.capture and tag == self.capture[0]:
                text = clean(" ".join(self.capture[1]), 500)
                if tag == "title":
                    self.page_title = text
                else:
                    self.headings.append(text)
                self.capture = None
            if tag == "a" and self.anchor:
                self.links.append((self.anchor[0], clean(" ".join(self.anchor[1]), 500)))
                self.anchor = None
            if tag in {"p", "li", "div", "section", "article", "h1", "h2", "h3", "dt", "dd"}:
                self.parts.append("\n")

    def handle_data(self, value):
        if self.script is not None:
            self.script.append(value)
        if not self.skip:
            self.parts.append(value + " ")
            if self.capture:
                self.capture[1].append(value)
            if self.anchor:
                self.anchor[1].append(value)

    @property
    def lines(self):
        return [clean(line) for line in "".join(self.parts).splitlines() if clean(line)]


def relevant(text, watch, official=False):
    value = clean(text, 100000).lower()
    words = [w for w in re.findall(r"[a-z]+", watch.get("name", "").lower()) if w not in STOP_WORDS and len(w) > 1]
    if not words:
        return official and bool(EVENT_WORDS.search(value))
    meaningful = set(words)
    present = sum(bool(re.search(r"\b" + re.escape(w) + r"\b", value)) for w in meaningful)
    acronym = "".join(w[0] for w in words)
    acronym_hit = len(acronym) >= 3 and bool(re.search(r"\b" + acronym + r"\b", value))
    needed = min(2, len(meaningful)) if official else max(1, (len(meaningful) * 2 + 2) // 3)
    return present >= needed or acronym_hit


def valid_date(value):
    if not isinstance(value, str):
        return ""
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?", value.strip())
    if not m:
        return ""
    try:
        day = dt.date.fromisoformat(m[1])
        return day.isoformat() if 1900 <= day.year <= 2200 else ""
    except ValueError:
        return ""


MONTHS = {m.lower(): i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], 1)}
MONTH_PATTERN = "(?:" + "|".join(MONTHS) + ")"
DATE_PATTERN = re.compile(r"\b(" + MONTH_PATTERN + r")\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[–—-]\s*(?:(" + MONTH_PATTERN + r")\s+)?(\d{1,2})(?:st|nd|rd|th)?)?,?\s+(20\d{2})\b", re.I)


def dates_in_text(text):
    results = []
    for m in DATE_PATTERN.finditer(text):
        month, start, end_month, end, year = m.groups()
        a = valid_date(f"{year}-{MONTHS[month.lower()]:02d}-{int(start):02d}")
        b = valid_date(f"{year}-{MONTHS[(end_month or month).lower()]:02d}-{int(end):02d}") if end else ""
        if a:
            results.append((a, b if not b or b >= a else "", m[0]))
    if not results:
        for m in re.finditer(r"\b\d{4}-\d{2}-\d{2}\b", text):
            day = valid_date(m[0])
            if day:
                results.append((day, "", m[0]))
    return results


def walk_events(value, depth=0):
    if depth > 12:
        return
    if isinstance(value, list):
        for item in value[:1000]:
            yield from walk_events(item, depth + 1)
    elif isinstance(value, dict):
        types = value.get("@type", [])
        if isinstance(types, str):
            types = [types.rsplit("/", 1)[-1]]
        if isinstance(types, list) and any(t.rsplit("/", 1)[-1] in EVENT_TYPES for t in types if isinstance(t, str)):
            yield value
        for key in ("@graph", "itemListElement", "item", "subEvent", "event", "mainEntity"):
            yield from walk_events(value.get(key), depth + 1)


def event_place(event):
    place = event.get("location", {})
    if isinstance(place, list):
        place = place[0] if place else {}
    if isinstance(place, str):
        return clean(place, 500), ""
    if not isinstance(place, dict):
        return "", ""
    address = place.get("address", {})
    if isinstance(address, str):
        return clean("; ".join(filter(None, [clean(place.get("name")), clean(address)])), 500), ""
    if not isinstance(address, dict):
        address = {}
    location = "; ".join(dict.fromkeys(filter(None, [clean(place.get("name")), clean(address.get("addressLocality")), clean(address.get("addressRegion"))])))
    return clean(location, 500), clean(address.get("addressRegion"), 80)


def title_identity(title):
    # A changed exact date becomes a distinct proposal; the title's identity remains stable.
    text = DATE_PATTERN.sub(" ", title.lower())
    text = re.sub(r"\b(?:19|20|21)\d{2}\b|\b\d{4}-\d{2}-\d{2}\b", " ", text)
    return " ".join(re.findall(r"[a-z0-9]+", text))


def identity(candidate):
    years = re.findall(r"\b(?:19|20|21)\d{2}\b", candidate["title"])
    year = candidate["startDate"][:4] or (years[0] if len(set(years)) == 1 else "undated")
    return "|".join([candidate["watchId"], candidate["organizationId"], canonical_url(candidate["url"]), title_identity(candidate["title"]), year])


def fingerprint(candidate):
    # Exact dates, title and relevant published terms change the proposal fingerprint.
    # The database never silently overwrites an already reviewed suggestion.
    version = json.dumps([identity(candidate), candidate["title"], candidate["startDate"], candidate["endDate"], candidate["location"], candidate["state"], candidate["sponsorshipDetails"]], ensure_ascii=False, separators=(",", ":"))
    return "conference-v1-" + hashlib.sha256(version.encode()).hexdigest()


def proposal(watch, title, url, start, end, location, state, excerpt, description, sponsorship, now, flags=None):
    flags = list(flags or [])
    if not start:
        flags.append("Date not verified; review the source before scheduling.")
        if end:
            end = ""
            flags.append("Published end date has no valid start date; dates left blank for review.")
    if end and start and end < start:
        end = ""
        flags.append("Published end date precedes start date; end date requires review.")
    if not location:
        flags.append("Venue not verified.")
    cutoff = end or start
    if cutoff and dt.date.fromisoformat(cutoff) < now.date():
        return None
    # Do not surface explicitly historical undated conference pages as future events.
    years = re.findall(r"\b(?:19|20|21)\d{2}\b", title)
    if not cutoff and years and max(map(int, years)) < now.year:
        return None
    item = {"id": "", "watchId": watch["id"], "organizationId": watch["organizationId"], "title": clean(title, 500), "startDate": start, "endDate": end, "location": clean(location, 500), "state": clean(state, 80), "url": canonical_url(url), "summary": clean(" ".join([description, *flags]), 6000), "sponsorshipDetails": clean(sponsorship, 6000), "evidence": [{"url": canonical_url(url), "excerpt": clean(excerpt, 4000)}], "fingerprint": "", "firstSeenAt": stamp(now), "lastSeenAt": stamp(now), "status": "new", "eventId": ""}
    item["fingerprint"] = fingerprint(item)
    item["id"] = "discovery-" + item["fingerprint"].split("-")[-1][:32]
    return item


def extract_candidates(page, url, watch, now, official=True):
    parser = EventHTML()
    parser.feed(page)
    candidates = []
    page_text = "\n".join(parser.lines)
    relevant_page = relevant(parser.page_title + " " + page_text, watch, official)
    sponsorship_lines = [line for line in parser.lines if re.search(r"\b(sponsor(?:ship)?|exhibitor|exhibit booth)\b", line, re.I)]
    sponsorship = " ".join(sponsorship_lines[:3])[:3000]
    structured_found = False
    for raw in parser.jsonld[:40]:
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        for event in walk_events(data):
            title = clean(event.get("name"), 500)
            if not title or not EVENT_WORDS.search(title + " " + clean(event.get("description"))):
                continue
            organizer = event.get("organizer", {})
            owner = json.dumps(organizer, ensure_ascii=False)[:2000]
            if not relevant(title + " " + owner + " " + clean(event.get("description")), watch, official) and not (official and relevant_page):
                continue
            structured_found = True
            if str(event.get("eventStatus", "")).endswith("EventCancelled"):
                continue
            start, end = valid_date(event.get("startDate")), valid_date(event.get("endDate"))
            location, state = event_place(event)
            fields = {k: event[k] for k in ["name", "startDate", "endDate", "location", "eventStatus", "organizer", "offers", "sponsor"] if k in event}
            excerpt = "JSON-LD Event fields: " + json.dumps(fields, ensure_ascii=False, separators=(",", ":"))
            flags = [] if official else ["Found outside watched organizer hosts; confirm the organizer."]
            if event.get("startDate") and not start:
                flags.append("Published date is incomplete or invalid; no year/date was inferred.")
            if event.get("eventStatus") and str(event["eventStatus"]).endswith("EventPostponed"):
                start, end = "", ""
                flags.append("Organizer marks this event postponed; confirm replacement dates.")
            # Page-wide sponsor copy can belong to another event on a multi-event page.
            sponsor = "Published sponsor field: " + clean(json.dumps(event["sponsor"], ensure_ascii=False), 2500) if event.get("sponsor") else ""
            item = proposal(watch, title, url, start, end, location, state, excerpt, clean(event.get("description"), 3000), sponsor, now, flags)
            if item:
                candidates.append(item)
    if not structured_found and relevant_page:
        titles = [t for t in parser.headings + [parser.page_title] if EVENT_WORDS.search(t) and not LISTING_TITLE.match(t)]
        if titles:
            title = titles[0]
            labeled = [line for line in parser.lines if re.search(r"^(?:conference\s+|event\s+)?(?:dates?|when)\s*:", line, re.I)]
            date_values = [value for line in [title, *labeled] for value in dates_in_text(line)]
            unique = list(dict.fromkeys((a, b) for a, b, _ in date_values))
            start, end = unique[0] if len(unique) == 1 else ("", "")
            locations = [line for line in parser.lines if re.match(r"(?:venue|location|where)\s*:", line, re.I)]
            location = re.sub(r"^[^:]+:\s*", "", locations[0])[:500] if len(locations) == 1 else ""
            flags = ["Page text extraction; confirm details against the organizer source."]
            if len(unique) > 1:
                flags.append("Multiple date statements found; dates left blank for review.")
            if not official:
                flags.append("Found outside watched organizer hosts; confirm the organizer.")
            excerpt = " | ".join([title, *labeled[:3], *locations[:2], *sponsorship_lines[:2]])
            item = proposal(watch, title, url, start, end, location, "", excerpt, "", sponsorship, now, flags)
            if item:
                candidates.append(item)
    return candidates, parser.links


def deduplicate(candidates, previous=()):
    existing = {}
    for item in previous:
        try:
            existing.setdefault(identity(item), []).append(item)
        except (KeyError, DiscoveryError):
            pass
    result = {}
    for item in candidates:
        prior = existing.get(identity(item), [])
        changed_from = next((x for x in prior if (x.get("startDate"), x.get("endDate")) != (item["startDate"], item["endDate"])), None)
        if changed_from:
            previous_dates = " to ".join(filter(None, [changed_from.get("startDate"), changed_from.get("endDate")])) or "unconfirmed dates"
            item["summary"] = f"Published dates differ from a previous suggestion for {clean(changed_from['title'], 500)} ({previous_dates}). Review this as a separate proposal; approved events are unchanged. " + item["summary"]
        result.setdefault(item["fingerprint"], item)
    return list(result.values())


class Budget:
    def __init__(self, pages=MAX_PAGES_PER_RUN, seconds=RUN_SECONDS):
        self.remaining = pages
        self.deadline = time.monotonic() + seconds
        self.lock = threading.Lock()

    def take(self):
        with self.lock:
            if self.remaining <= 0 or time.monotonic() >= self.deadline:
                return False
            self.remaining -= 1
            return True

    def active(self):
        with self.lock:
            return self.remaining > 0 and time.monotonic() < self.deadline


def brave_results(watch, key, fetcher):
    if not key:
        return []
    query = clean(watch.get("name", "") + " " + watch.get("searchTerms", "") + " conference events", 580)
    endpoint = "https://api.search.brave.com/res/v1/web/search?" + urlencode({"q": query, "count": 5, "country": "US", "search_lang": "en"})
    # A search token goes only to this fixed API origin; redirects are never followed.
    r = fetcher._once(endpoint, headers={"X-Subscription-Token": key, "Accept": "application/json"})
    if r.status != 200:
        raise DiscoveryError("search_provider_unavailable")
    try:
        rows = json.loads(r.body).get("web", {}).get("results", [])
        return [(row["url"], clean(row.get("title"), 500)) for row in rows[:5] if isinstance(row, dict) and isinstance(row.get("url"), str)]
    except (ValueError, TypeError, AttributeError):
        raise DiscoveryError("search_provider_invalid_response") from None


def crawl_watch(watch, fetcher, now, budget, search_key=""):
    queue, known_hosts = [], set()
    failures, checked, successful, proposals = 0, 0, 0, []
    if not budget.active():
        return [], 0, 1, 0
    for source in watch.get("sourceUrls", [])[:20]:
        try:
            url = canonical_url(source)
            queue.append((url, "", True))
            known_hosts.add(urlsplit(url).hostname)
        except DiscoveryError:
            failures += 1
    if search_key:
        try:
            for url, label in brave_results(watch, search_key, fetcher):
                queue.append((canonical_url(url), label, urlsplit(url).hostname in known_hosts))
        except DiscoveryError:
            failures += 1
    seen = set()
    if not queue:
        failures += 1
    while queue and checked < MAX_PAGES_PER_WATCH:
        url, label, official = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        if not budget.take():
            failures += 1
            break
        checked += 1
        try:
            r = fetcher.get(url)
            seen.add(canonical_url(r.url))
            if r.status != 200:
                failures += 1
                continue
            successful += 1
            content_type = r.headers.get("content-type", "").lower()
            # An unrelated redirect does not inherit the configured organizer identity.
            redirected_host = urlsplit(r.url).hostname
            source_host = urlsplit(url).hostname
            host_alias = redirected_host.removeprefix("www.") == source_host.removeprefix("www.")
            confirmed_official = official and (redirected_host in known_hosts or host_alias)
            if "pdf" in content_type or r.body.startswith(b"%PDF-"):
                title = label or urlsplit(r.url).path.rsplit("/", 1)[-1].replace("_", " ").replace("-", " ")
                if not confirmed_official and not (EVENT_WORDS.search(title) and relevant(title, watch)):
                    continue
                item = proposal(watch, title or watch["name"] + " source document", r.url, "", "", "", "", "Linked PDF: " + (label or title), "PDF source only; title, dates, venue and sponsorship terms require manual review. PDF contents were not parsed.", "", now)
                if item:
                    proposals.append(item)
                continue
            if "html" not in content_type and not r.body.lstrip().lower().startswith((b"<!doctype html", b"<html")):
                continue
            encoding = re.search(r"charset=([\w-]+)", content_type)
            try:
                text = r.body.decode(encoding[1] if encoding else "utf-8", "replace")
            except LookupError:
                text = r.body.decode("utf-8", "replace")
            candidates, links = extract_candidates(text, r.url, watch, now, confirmed_official)
            proposals.extend(candidates)
            relevant_links = []
            for href, anchor in links:
                if not LINK_WORDS.search(href + " " + anchor) or re.search(r"logout|sign.?in|sign.?up|wp-admin|mailto:|javascript:", href, re.I):
                    continue
                try:
                    target = canonical_url(urljoin(r.url, href))
                    if urlsplit(target).hostname == redirected_host and target not in seen:
                        relevant_links.append((target, anchor, confirmed_official))
                except DiscoveryError:
                    continue
            # Event pages are more useful than generic calendar/sponsor index pages.
            relevant_links.sort(key=lambda v: (not bool(EVENT_WORDS.search(v[1])), len(v[0])))
            queue.extend(relevant_links[:24])
        except (DiscoveryError, ValueError, RecursionError):
            failures += 1
    if queue and checked >= MAX_PAGES_PER_WATCH:
        failures += 1
    return proposals, checked, failures, successful


class Database:
    def __init__(self, url, key, fetcher=None):
        self.url = canonical_url(url)
        p = urlsplit(self.url)
        if p.scheme != "https" or p.path != "/" or p.query:
            raise DiscoveryError("invalid_database_origin")
        self.key = key
        self.fetcher = fetcher or PublicFetcher()

    def rpc(self, name, args):
        if name not in {"core_discovery_context", "core_ingest_discoveries"}:
            raise DiscoveryError("invalid_database_operation")
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json"}
        # Modern sb_secret keys authenticate at the Supabase gateway. Legacy service-role JWTs
        # also need Authorization. Neither header is ever given to the organizer fetcher.
        if not self.key.startswith("sb_secret_"):
            headers["Authorization"] = "Bearer " + self.key
        body = json.dumps(args, ensure_ascii=False).encode()
        response = self.fetcher._once(self.url.rstrip("/") + "/rest/v1/rpc/" + name, headers, "POST", body, 24 * 1024 * 1024)
        if response.status != 200:
            # Database bodies can contain private information; never log them or follow redirects.
            raise DiscoveryError("database_request_failed_" + str(response.status))
        try:
            value = json.loads(response.body)
            if not isinstance(value, dict) or not isinstance(value.get("data"), dict):
                raise ValueError()
            return value
        except (ValueError, TypeError):
            raise DiscoveryError("invalid_database_response") from None


def run(database, workspace_id, now=None, force=False, search_key="", fetcher=None):
    now = now or dt.datetime.now(UTC)
    snapshot = database.rpc("core_discovery_context", {"p_workspace_id": workspace_id})
    data = snapshot["data"]
    if not is_due(data.get("settings", {}), now, force):
        return {"outcome": "skipped_disabled_or_not_due"}
    watches = [w for w in data.get("watches", []) if w.get("enabled")]
    if not watches:
        return {"outcome": "skipped_no_enabled_watches"}
    budget, fetcher = Budget(), fetcher or PublicFetcher()
    candidates, checked, failures, successful = [], 0, 0, 0
    # Two workers; each host also observes a minimum interval and declared crawl-delay.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(crawl_watch, w, fetcher, now, budget, search_key) for w in watches]
        for future in futures:
            try:
                found, pages, errors, completed = future.result()
                candidates.extend(found)
                checked += pages
                failures += errors
                successful += completed
            except Exception:
                failures += 1
    candidates = deduplicate(candidates, data.get("discoveries", []))
    bounded, payload_bytes = [], 2
    for item in candidates:
        item_bytes = len(json.dumps(item, ensure_ascii=False).encode()) + 2
        if len(bounded) >= MAX_CANDIDATES or payload_bytes + item_bytes > MAX_CANDIDATE_BYTES:
            failures += 1
            break
        bounded.append(item)
        payload_bytes += item_bytes
    candidates = bounded
    mode = "Organizer-site monitoring plus optional web search; coverage is bounded, not exhaustive." if search_key else "Organizer-site monitoring only; broader web search is not configured. Coverage is bounded, not exhaustive."
    message = f"{mode} {len(watches)} enabled watches; {failures} fetch/search/limit issues. Undated items and PDF links require review."
    status = "partial" if failures else "success"
    if failures and successful == 0:
        status = "failed"
    record = {"id": "run-" + str(uuid.uuid4()), "startedAt": stamp(now), "finishedAt": stamp(), "status": status, "pagesChecked": checked, "candidatesFound": len(candidates), "message": message}
    # The database deduplicates and preserves reviews, decisions, invoices, tasks and event plans.
    database.rpc("core_ingest_discoveries", {"p_workspace_id": workspace_id, "p_candidates": candidates, "p_run": record})
    return {"outcome": status, "pagesChecked": checked, "candidatesFound": len(candidates), "issues": failures}


def main():
    secret = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if not secret:
        print("SKIPPED: SUPABASE_SECRET_KEY is not configured; no discovery or database write was attempted.")
        return 0
    url = os.environ.get("SUPABASE_URL", "").strip()
    if not url:
        print("FAILED: SUPABASE_URL is not configured; no discovery was attempted.")
        return 1
    try:
        result = run(Database(url, secret), os.environ.get("CORE_WORKSPACE_ID", "core-midwest"), force=os.environ.get("DISCOVERY_FORCE", "false").lower() == "true", search_key=os.environ.get("BRAVE_SEARCH_API_KEY", ""))
        # Only operational counts are public; names, URLs, candidates, RPC bodies and secrets are not.
        print("Conference discovery: " + json.dumps(result, sort_keys=True))
        return 1 if result["outcome"] == "failed" else 0
    except DiscoveryError as error:
        print("FAILED: " + str(error) + ". No response bodies or private workspace data were logged.")
        return 1
    except Exception:
        print("FAILED: unexpected_discovery_error. No private data or exception details were logged.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
