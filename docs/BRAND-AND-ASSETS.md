# CORE Midwest brand and organization assets

## CORE identity

Source: **2026 Employee Brand Guide (1).pdf**, supplied by CORE Midwest. The app uses the approved registered primary CORE mark extracted from the guide, kept proportional on white. The symbol is used for the favicon. “CORE Midwest” is explicit regional text next to the mark, not a modification of the logo lockup. The retired “CONSTRUCTION” lockup is not used.

Brand colors: CORE Green `#008348`, black `#000000`, asphalt `#282828`, concrete `#F2F3F3`, and white. Neutral UI borders and semantic feedback colors support readability. Typography is Segoe UI Regular/Bold, with Arial/system fallback where Segoe UI is not installed. No font binaries are distributed.

Assets: `public/brand/core-logo.png` and `public/brand/core-symbol.png`. Whitespace preserves the guide's intent; the guide does not provide a numeric minimum size or clear-space ratio, so none is claimed.

## Organization marks

The package includes verified marks or official website icons. Unresolved identities use initials because a matching public mark could not be verified or retrieved, or the name does not identify a distinct organization. Missing reasons and source locations are recorded individually in `logo-sources.json`.

Some school/foundation identities use the foundation's authentic mark. School clubs may use a disclosed parent-school mark; other identities may use a parent association or city mark. Triple I and the ISBA/IAPSS fall conference use official 2026 event artwork. These are identified as related organization/program marks in the app, rather than presented as exact standalone logos for the named organization.

Every installed image was visually checked against the identified source. White marks are displayed on a dark tile where required. Images are locally packaged to avoid hotlink dependence and keep the layout stable. They retain their proportions and are not recolored. SVG files are loaded as image resources rather than injected into the document.

`lib/logo-catalog.json` maps organization IDs to local assets and provenance. `docs/logo-sources.json` records all available and unresolved entries. New organizations receive initials automatically. To add a verified logo, place it in `public/organizations/` and add its ID, relative path, source page, asset URL and identity scope to the catalog. Set `requiresDarkBackground` for white marks.

CORE and third-party marks remain the property of their owners. Inclusion identifies the organization associated with a spending record and does not imply endorsement or grant additional trademark rights.
