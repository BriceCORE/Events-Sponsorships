#!/usr/bin/env python3
"""Offline tests with synthetic fixtures; no Supabase or organizer requests."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("conference_discovery", ROOT / "discover-conferences.py")
d = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = d
SPEC.loader.exec_module(d)
NOW = dt.datetime(2026, 9, 23, 12, tzinfo=d.UTC)
WATCH = {"id": "watch-example", "organizationId": "org-example", "name": "Example School Business Association", "sourceUrls": ["https://example.org/events"], "searchTerms": "annual conference", "enabled": True}


def fixture(name):
    return (ROOT / "fixtures" / "conference-discovery" / name).read_text()


def resolver(host, port, **kwargs):
    ip = host if host in {"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"} else "93.184.216.34"
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]


class FakeSite:
    def __init__(self, routes=None):
        self.routes, self.calls = routes or {}, []

    def __call__(self, url, address, headers, method="GET", body=None, limit=d.MAX_BYTES):
        self.calls.append({"url": url, "address": address, "headers": headers, "method": method, "body": body})
        if url.endswith("/robots.txt") and url not in self.routes:
            return d.Response(url, 404, {}, b"")
        status, response_headers, content = self.routes.get(url, (404, {}, b""))
        return d.Response(url, status, response_headers, content.encode() if isinstance(content, str) else content)

    def fetcher(self, dns=resolver):
        return d.PublicFetcher(resolver=dns, send=self, pause=lambda _: None)


class FakeDatabase:
    def __init__(self, settings=None, watches=None, discoveries=None):
        self.data = {"settings": settings or {"enabled": True, "intervalDays": 14, "nextRunAt": "", "lastRunAt": ""}, "watches": [copy.deepcopy(WATCH)] if watches is None else watches, "discoveries": discoveries or []}
        self.calls = []

    def rpc(self, name, args):
        self.calls.append((name, copy.deepcopy(args)))
        return {"data": self.data, "revision": 1, "role": "owner"}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        # A stray real network connection makes any test fail.
        self.network = patch.object(socket, "create_connection", side_effect=AssertionError("Network access is forbidden in fixtures"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def extract(self, page, official=True):
        return d.extract_candidates(page, "https://example.org/events", WATCH, NOW, official)[0]

    def test_jsonld_graph_and_event_types(self):
        rows = self.extract(fixture("events.html"))
        self.assertEqual(len(rows), 2)
        event = rows[0]
        self.assertEqual((event["startDate"], event["endDate"]), ("2027-04-12", "2027-04-14"))
        self.assertEqual(event["state"], "IN")
        self.assertIn("Example Convention Center", event["location"])
        self.assertIn('"startDate":"2027-04-12T08:00:00-04:00"', event["evidence"][0]["excerpt"])
        self.assertIn("Partner showcase", event["sponsorshipDetails"])
        self.assertNotIn("page-wide", event["sponsorshipDetails"])
        self.assertEqual(event["status"], "new")
        self.assertEqual(event["eventId"], "")

    def test_cancelled_and_past_excluded_postponed_is_uncertain(self):
        rows = self.extract(fixture("events.html"))
        self.assertFalse(any("Past" in x["title"] or "Cancelled" in x["title"] for x in rows))
        postponed = next(x for x in rows if "Postponed" in x["title"])
        self.assertEqual(postponed["startDate"], "")
        self.assertIn("postponed", postponed["summary"])

    def test_labeled_dates_venue_and_sponsorship_evidence(self):
        row, = self.extract(fixture("labeled.html"))
        self.assertEqual((row["startDate"], row["endDate"]), ("2027-10-12", "2027-10-14"))
        self.assertEqual(row["location"], "Example Hall, Indianapolis, IN")
        self.assertIn("one display table", row["sponsorshipDetails"])
        self.assertIn("Dates: October 12–14, 2027", row["evidence"][0]["excerpt"])
        self.assertNotIn("September", row["startDate"])

    def test_no_future_year_inference_from_footer_or_registration(self):
        row, = self.extract(fixture("uncertain.html"))
        self.assertEqual(row["startDate"], "")
        self.assertEqual(row["endDate"], "")
        self.assertIn("Date not verified", row["summary"])
        self.assertEqual(d.dates_in_text("Dates: October 12–14"), [])

    def test_ambiguous_dates_left_blank(self):
        page = fixture("labeled.html").replace("</body>", "<p>Dates: October 15, 2027</p></body>")
        row, = self.extract(page)
        self.assertEqual(row["startDate"], "")
        self.assertIn("Multiple date statements", row["summary"])

    def test_valid_dates_and_bounds(self):
        for value in ["2027-02-29", "04/12/2027", "April 12", "3000-01-01", "2027-13-01", None, "2027-04-12junk"]:
            self.assertEqual(d.valid_date(value), "", repr(value))
        self.assertEqual(d.valid_date("2028-02-29"), "2028-02-29")
        self.assertEqual(d.dates_in_text("March 30–April 2, 2027")[0][:2], ("2027-03-30", "2027-04-02"))
        self.assertEqual(d.dates_in_text("February 30, 2027"), [])

    def test_clean_obeys_browser_utf16_limits_without_broken_surrogates(self):
        self.assertEqual(d.clean("😀" * 3000, 4000), "😀" * 2000)
        self.assertEqual(d.clean("ab😀cd", 3), "ab")
        self.assertEqual(d.clean("ab😀cd", 4), "ab😀")
        self.assertEqual(d.clean("before\ud800after\udc00", 100), "beforeafter")
        self.assertEqual(d.clean("\ud83d\ude00", 2), "😀")

    def test_clean_removes_nul_before_database_serialization(self):
        self.assertEqual(d.clean("Sponsor\x00 terms\x00"), "Sponsor terms")
        event = {"@type": "Event", "name": "ESBA Conference\x00 2027 " + "😀" * 300,
                 "startDate": "2027-10-12", "description": "Public conference " + "😀" * 4000,
                 "organizer": {"name": WATCH["name"]}, "sponsor": {"name": "Partner\x00 " + "😀" * 3000}}
        row, = self.extract('<script type="application/ld+json">' + json.dumps(event) + '</script>')
        bounds = {"title": 500, "summary": 10000, "location": 500, "state": 500, "sponsorshipDetails": 10000}
        for field, bound in bounds.items():
            self.assertLessEqual(len(row[field].encode("utf-16-le")) // 2, bound, field)
            self.assertNotIn("\x00", row[field])
        self.assertLessEqual(len(row["evidence"][0]["excerpt"].encode("utf-16-le")) // 2, 4000)
        self.assertNotIn("\x00", row["evidence"][0]["excerpt"])
        json.dumps(row, ensure_ascii=False).encode("utf-8")

    def test_missing_start_with_end_is_reviewable_not_invalid(self):
        row = d.proposal(WATCH, "ESBA Conference 2027", "https://example.org/events", "", "2027-10-14", "", "", "Published end date", "", "", NOW)
        self.assertEqual((row["startDate"], row["endDate"]), ("", ""))
        self.assertIn("no valid start date", row["summary"])

    def test_ongoing_event_retained_and_past_undated_year_excluded(self):
        kwargs = [WATCH, "ESBA Conference", "https://example.org/events", "2026-09-22", "2026-09-24", "", "", "source", "", "", NOW]
        self.assertIsNotNone(d.proposal(*kwargs))
        kwargs[1], kwargs[3], kwargs[4] = "ESBA Conference 2025", "", ""
        self.assertIsNone(d.proposal(*kwargs))

    def test_relevance_rejects_unrelated_third_party(self):
        self.assertTrue(d.relevant("ESBA Annual Conference", WATCH))
        self.assertFalse(d.relevant("School conference for unrelated association", WATCH))
        unrelated = fixture("events.html").replace("Example School Business Association", "Unrelated Tourism Board").replace("ESBA", "UTB")
        self.assertEqual(self.extract(unrelated, official=False), [])

    def test_generic_calendar_not_a_conference(self):
        self.assertEqual(self.extract("<title>Example School Business Association</title><h1>Upcoming conferences</h1><p>2027-04-12</p>"), [])

    def test_url_canonicalization_and_credentials(self):
        self.assertEqual(d.canonical_url("https://Example.ORG:443/events?utm_source=x&b=2&a=1#top"), "https://example.org/events?a=1&b=2")
        for value in ["file:///etc/passwd", "https://user:pass@example.org", "https://localhost/events", "http://foo.internal", "https://example.org:8443", "https://example.org\\@private", "https://example.org/white space"]:
            with self.assertRaises(d.DiscoveryError, msg=value):
                d.canonical_url(value)

    def test_private_reserved_and_mixed_dns_rejected(self):
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "192.0.2.10", "::ffff:8.8.8.8", "224.0.0.1"]:
            with self.assertRaises(d.DiscoveryError, msg=address):
                d.public_addresses("https://example.org", lambda *a, **k: [(2, 1, 6, "", (address, 443))])
        with self.assertRaises(d.DiscoveryError):
            d.public_addresses("https://example.org", lambda *a, **k: [(2, 1, 6, "", (ip, 443)) for ip in ["93.184.216.34", "10.0.0.1"]])

    def test_private_redirect_blocked_before_request(self):
        site = FakeSite({"https://example.org/events": (302, {"location": "http://169.254.169.254/latest/meta-data"}, b"")})
        with self.assertRaises(d.DiscoveryError):
            site.fetcher().get("https://example.org/events")
        self.assertTrue(all("169.254" not in call["url"] for call in site.calls))

    def test_dns_rebinding_is_checked_again_at_connection(self):
        count = 0
        def changing(host, port, **kwargs):
            nonlocal count
            count += 1
            return [(2, 1, 6, "", ("93.184.216.34" if count <= 2 else "127.0.0.1", port))]
        site = FakeSite()
        with self.assertRaises(d.DiscoveryError):
            site.fetcher(changing).get("https://example.org/events")
        self.assertEqual([x["url"] for x in site.calls], ["https://example.org/robots.txt"])

    def test_redirect_obeys_destination_robots(self):
        site = FakeSite({"https://example.org/events": (302, {"location": "https://other.org/events"}, b""), "https://other.org/robots.txt": (200, {}, "User-agent: *\nDisallow: /events")})
        with self.assertRaises(d.DiscoveryError):
            site.fetcher().get("https://example.org/events")
        self.assertNotIn("https://other.org/events", [x["url"] for x in site.calls])

    def test_robots_allow_disallow_wildcard_and_agent(self):
        rules = d.Robots("User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\n")
        self.assertFalse(rules.allowed("https://example.org/private/a"))
        self.assertFalse(rules.allowed("https://example.org/%70rivate/a"))
        self.assertTrue(rules.allowed("https://example.org/private/public/a"))
        self.assertFalse(rules.allowed("https://example.org/file.pdf"))
        self.assertTrue(rules.allowed("https://example.org/file.pdf?download=1"))
        specific = d.Robots("User-agent: *\nDisallow: /\nUser-agent: CoreConferenceDiscovery\nDisallow:\n")
        self.assertTrue(specific.allowed("https://example.org/events"))
        self.assertFalse(d.Robots("User-agent: *\nCrawl-delay: 120\n").allowed("https://example.org/events"))

    def test_robots_unavailable_fails_closed(self):
        site = FakeSite({"https://example.org/robots.txt": (503, {}, b"")})
        with self.assertRaises(d.DiscoveryError):
            site.fetcher().get("https://example.org/events")
        self.assertEqual(len(site.calls), 1)

    def test_fourteen_day_due_gate_force_and_disabled(self):
        settings = {"enabled": True, "intervalDays": 14, "lastRunAt": "2026-09-09T12:00:00Z", "nextRunAt": ""}
        self.assertTrue(d.is_due(settings, NOW))
        self.assertFalse(d.is_due(settings, NOW - dt.timedelta(seconds=1)))
        settings["nextRunAt"] = "2026-09-24T12:00:00Z"
        self.assertFalse(d.is_due(settings, NOW))
        self.assertTrue(d.is_due(settings, NOW, force=True))
        settings["enabled"] = False
        self.assertFalse(d.is_due(settings, NOW, force=True))
        with self.assertRaises(d.DiscoveryError):
            d.is_due({"enabled": True, "intervalDays": 7}, NOW)

    def test_stable_dedup_and_changed_proposals(self):
        row = self.extract(fixture("labeled.html"))[0]
        tracking = copy.deepcopy(row)
        tracking["url"] += "?utm_source=email"
        self.assertEqual(d.fingerprint(row), d.fingerprint(tracking))
        self.assertEqual(len(d.deduplicate([row, copy.deepcopy(row)])), 1)
        old = copy.deepcopy(row)
        old.update({"status": "accepted", "eventId": "existing-event"})
        changed = copy.deepcopy(row)
        changed["startDate"], changed["endDate"] = "2027-10-15", "2027-10-17"
        changed["fingerprint"] = d.fingerprint(changed)
        self.assertNotEqual(row["fingerprint"], changed["fingerprint"])
        result = d.deduplicate([changed], [old])[0]
        self.assertIn("Published dates differ", result["summary"])
        self.assertEqual(old["eventId"], "existing-event")
        self.assertEqual(old["startDate"], "2027-10-12")
        for field in ["title", "location", "sponsorshipDetails"]:
            another = copy.deepcopy(row)
            another[field] += " changed"
            self.assertNotEqual(d.fingerprint(row), d.fingerprint(another))

    def test_crawl_bounds_same_host_and_secret_isolation(self):
        routes = {"https://example.org/events": (200, {"content-type": "text/html"}, fixture("labeled.html") + "".join(f'<a href="/conference-{i}">Conference {i}</a>' for i in range(20)) + '<a href="https://other.org/conference">Other</a>')}
        routes.update({f"https://example.org/conference-{i}": (200, {"content-type": "text/html"}, fixture("labeled.html")) for i in range(20)})
        site = FakeSite(routes)
        _, checked, issues, completed = d.crawl_watch(WATCH, site.fetcher(), NOW, d.Budget())
        self.assertEqual(checked, 8)
        self.assertEqual(completed, 8)
        self.assertGreater(issues, 0)
        self.assertTrue(all(x["url"].startswith("https://example.org/") for x in site.calls))
        for call in site.calls:
            self.assertFalse({"apikey", "Authorization", "X-Subscription-Token"} & set(call["headers"]))
            self.assertEqual(call["address"], "93.184.216.34")

    def test_pdf_only_is_explicit_review_source(self):
        site = FakeSite({"https://example.org/events": (200, {"content-type": "application/pdf"}, b"%PDF-1.4")})
        rows, _, _, _ = d.crawl_watch(WATCH, site.fetcher(), NOW, d.Budget())
        self.assertEqual(rows[0]["startDate"], "")
        self.assertIn("PDF contents were not parsed", rows[0]["summary"])

    def test_rpc_modern_and_legacy_keys_and_no_redirect(self):
        endpoint = "https://database.example.org/rest/v1/rpc/core_discovery_context"
        for key in ["sb_secret_TEST_ONLY", "eyJ.LEGACY_TEST_ONLY"]:
            site = FakeSite({endpoint: (200, {}, json.dumps({"data": {}}))})
            db = d.Database("https://database.example.org", key, site.fetcher())
            db.rpc("core_discovery_context", {"p_workspace_id": "fixture"})
            self.assertEqual(site.calls[0]["headers"]["apikey"], key)
            self.assertEqual("Authorization" in site.calls[0]["headers"], not key.startswith("sb_secret_"))
        site = FakeSite({endpoint: (302, {"location": "https://other.org"}, b"PRIVATE RESPONSE MUST NOT BE LOGGED")})
        with self.assertRaisesRegex(d.DiscoveryError, "^database_request_failed_302$"):
            d.Database("https://database.example.org", "sb_secret_TEST_ONLY", site.fetcher()).rpc("core_discovery_context", {})
        self.assertEqual(len(site.calls), 1)

    def test_run_not_due_or_disabled_has_no_ingest_or_crawl(self):
        for enabled in [False, True]:
            db = FakeDatabase(settings={"enabled": enabled, "intervalDays": 14, "nextRunAt": "2026-10-01T00:00:00Z"})
            site = FakeSite()
            result = d.run(db, "fixture", NOW, fetcher=site.fetcher())
            self.assertEqual(result["outcome"], "skipped_disabled_or_not_due")
            self.assertEqual(len(db.calls), 1)
            self.assertEqual(site.calls, [])

    def test_run_only_ingests_suggestions_and_operational_run(self):
        db = FakeDatabase()
        original = copy.deepcopy(db.data)
        site = FakeSite({"https://example.org/events": (200, {"content-type": "text/html"}, fixture("labeled.html"))})
        result = d.run(db, "fixture", NOW, fetcher=site.fetcher())
        self.assertEqual(result["outcome"], "success")
        self.assertEqual(db.data, original)
        name, args = db.calls[-1]
        self.assertEqual(name, "core_ingest_discoveries")
        self.assertEqual(set(args), {"p_workspace_id", "p_candidates", "p_run"})
        self.assertEqual(len(args["p_candidates"]), 1)
        self.assertNotIn("Example", args["p_run"]["message"])
        self.assertIn("broader web search is not configured", args["p_run"]["message"])

    def test_all_fetches_failed_records_failure_without_private_errors(self):
        db = FakeDatabase()
        site = FakeSite({"https://example.org/robots.txt": (503, {}, "private error")})
        result = d.run(db, "fixture", NOW, fetcher=site.fetcher())
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(db.calls[-1][1]["p_candidates"], [])
        self.assertNotIn("private error", json.dumps(db.calls[-1][1]))

    def test_missing_secret_is_clear_skip(self):
        output = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(output):
            self.assertEqual(d.main(), 0)
        self.assertIn("SKIPPED: SUPABASE_SECRET_KEY", output.getvalue())

    def test_expired_global_budget_does_not_search_or_fetch(self):
        site = FakeSite()
        result = d.crawl_watch(WATCH, site.fetcher(), NOW, d.Budget(pages=0), "test-search-secret")
        self.assertEqual(result, ([], 0, 1, 0))
        self.assertEqual(site.calls, [])

    def test_search_token_only_goes_to_fixed_provider_and_redirect_is_rejected(self):
        class RedirectProvider:
            def __init__(self):
                self.calls = []
            def _once(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return d.Response(url, 302, {"location": "https://other.org"}, b"private response")
        provider = RedirectProvider()
        with self.assertRaisesRegex(d.DiscoveryError, "^search_provider_unavailable$"):
            d.brave_results(WATCH, "SEARCH_TEST_ONLY", provider)
        self.assertEqual(len(provider.calls), 1)
        url, args = provider.calls[0]
        self.assertTrue(url.startswith("https://api.search.brave.com/res/v1/web/search?"))
        self.assertEqual(args["headers"]["X-Subscription-Token"], "SEARCH_TEST_ONLY")

    def test_transport_has_size_cap_and_uses_the_validated_address(self):
        from unittest.mock import MagicMock
        sock, connection, result = MagicMock(), MagicMock(), MagicMock()
        result.status, result.getheaders.return_value = 200, []
        result.read1.side_effect = [b"12345"]
        connection.getresponse.return_value = result
        with patch.object(socket, "create_connection", return_value=sock) as connect, patch.object(d.http.client, "HTTPConnection", return_value=connection):
            with self.assertRaisesRegex(d.DiscoveryError, "^response_size_limit$"):
                d.transport("http://example.org/events", "93.184.216.34", {}, limit=4)
        connect.assert_called_once_with(("93.184.216.34", 80), timeout=d.TIMEOUT)
        self.assertEqual(connection.request.call_args.kwargs["headers"]["Host"], "example.org")


if __name__ == "__main__":
    unittest.main(verbosity=2)
