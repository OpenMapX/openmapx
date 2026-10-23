---
description: Declare source terms, capture immutable licensing receipts, and render required attribution.
title: Licence metadata
---

Use this contract when declaring provider terms, capturing result credits, or
rendering attribution. For the repository's own code licences, see
[LICENSING.md](https://github.com/OpenMapX/openmapx/blob/main/LICENSING.md).

Data-source declarations and captured result receipts use the same portable
`Licensing` contract from `@openmapx/mobility-core/licensing`. A manifest source
requires `licensing` with at least one binding (use `unknown` when appropriate). An `Attribution` may omit it when no licence declaration is
known. There are no scalar `license`, `spdxLicense` or `licenseUrl` display fields
and no adapters for earlier OpenMapX formats. The integration/package's own
`license` remains its SPDX code licence; it grants no rights to provider data.

```json
{
  "version": 1,
  "bindings": [
    {
      "scope": "software",
      "subject": "Routing engine",
      "license": { "kind": "spdx", "expression": "MIT" }
    },
    {
      "scope": "data",
      "subject": "OpenStreetMap routing data",
      "license": { "kind": "spdx", "expression": "ODbL-1.0" }
    }
  ]
}
```

Each binding identifies one subject and scope: `data`, `imagery`, `style`,
`software` or `service`. Engine/specification licences belong to software;
API account restrictions belong to service. Neither licenses the output data.
Distinct suppliers and mandatory notices remain distinct even if they use the
same licence. Software bindings appear in legal details; map and content
credits display the applicable content and service bindings.

For a registered grant, use its exact [SPDX identifier](https://spdx.org/licenses/),
including version and jurisdiction. A pure expression can use `AND` for
simultaneous obligations, `OR` for a verified choice on the same subject and
`WITH` for a registered exception. A slash or semicolon in an upstream label
does not establish that relationship. Split independent subjects into bindings.
Do not infer data rights from an engine's licence or from public availability.

Custom terms require a self-contained definition:

```json
{
  "scope": "service",
  "subject": "Example API",
  "license": {
    "kind": "custom",
    "namespace": "extension:example",
    "id": "LicenseRef-Example-API-Terms",
    "name": "Example API Terms of Use",
    "url": "https://example.com/terms",
    "version": "2026-10"
  },
  "conditions": ["Use the account plan applicable to this request"]
}
```

Reuse a reference only for the same terms. Capture the definition and reviewed
conditions with the record; a client never resolves an old receipt against a
mutable licence catalogue. Installed extensions use their own stable namespace;
there is no global registration API. A custom reference is descriptive metadata,
not a permission approval. OpenConditions continues to decide redistribution
from its reviewed policy IDs and effective rights, independently of display
bindings.

Other descriptors are explicit: `{ "kind": "unknown", "raw": "..." }`,
`{ "kind": "per-item", "raw": "..." }`,
`{ "kind": "public-domain", "name": "U.S. Public Domain" }`, or
`{ "kind": "status", "id": "CC-PDM-1.0" }`. Missing versions, per-file grants,
public-domain evidence and status marks must not become invented SPDX grants.
Original supplier declarations can be retained in `declarations: [{ "text":
"...", "url": "https://..." }]`; these are evidence, not combined display
labels or a permission selector. Bindings retain the actual conditions and
required wording separately in `conditions` and `notice`. Source-wide
`attributionText` remains the publisher's original required notice. Manifest
`dataSources[].notes` is operator/privacy context and is not copied into result
credits. Put required wording in `attribution`, or in the relevant binding's
`notice`/`conditions`. A captured receipt's own `notes` is reserved for supplied
credit or modification notices and remains available in Credits.

`parseLicensing` validates and copies the complete bounded structure. Unknown
versions, malformed expressions, undefined custom references and unsafe licence
URLs are rejected. `parseContributors`, snapshot/union helpers, field receipts,
GeoJSON/MVT serialization and native wire validation retain every nested binding
and definition. Malformed field receipt maps are rejected as a whole, so a bad
child cannot silently inherit an unrelated parent's credit.
`readCapturedContributors` and `readCapturedFieldContributors` distinguish absent
metadata from a present malformed capture: malformed values become authoritative
empty receipts/maps, so acquisition and display cannot borrow a fallback grant.

Use `formatLicensing` for plain labels, `licensingLinks` for structured labels
and links, and the host's `buildLicensingHtml` / `buildRuntimeAttributionHtml` for
safe HTML. Server-rendered pages import these helpers from the focused
`@openmapx/core/attribution` entry point, which does not import React hooks. Registered identifiers, full names and links derive from the shared
SPDX registry; an expression retains every atom/exception link. Custom names
come from the captured definition. Do not rebuild labels by replacing hyphens,
guessing a licence from a URL substring, or splitting raw composite strings.

Per-file imagery captures `licensing`, creator, file page and notices before
caching. Built-in photo providers use `withPhotoContributors` for the same
immutable receipt shape as other records. Community companions must return
canonical `contributors` and `fieldContributors` for the actual items/fields;
licensing metadata does not substitute for contribution provenance. Presentation
must still credit only retained items and rendered geometry after filters,
viewport and zoom rules. Placement follows the reviewed contract below.

## Implementation checklist

1. Declare each source and its data, imagery, style, software, or service
   obligations in the manifest. Use an explicit unknown descriptor where rights
   are unresolved.
2. Capture the declaration and the actual item/field contributors before
   acquisition and caching. Preserve explicit empty receipts.
3. Project receipts for retained records, fields, and rendered geometry. Do not
   credit a discarded item or borrow another image's licence.
4. Render through the shared host helpers and test full notices, unsafe URLs,
   unknown terms, and required branding on the affected surface.
5. Run `pnpm check-license-metadata` for declarations and the affected attribution
   tests from the repository root. Metadata validation does not establish that
   provider terms permit a proposed use.

The portable implementation is in `packages/extension-contracts/src/licensing.ts`
and `attribution.ts`; `@openmapx/mobility-core` re-exports the licensing contract.
Placement defaults live in `packages/mobility-core/src/attribution-placement.ts`,
and host HTML rendering lives in `packages/core/src/utils/attribution.ts`.

## Location tables

OpenConditions places some records with a third-party location reference
table and names it on the record as `location.locationTable`: `{ ref, version,
attribution?, license? }`. The OpenConditions integration credits a table that
states a notice beside the record's sources (`locationTableCredits` in
`integrations/openconditions/features/record.ts`), on road events and on every
hazards record, native producer receipts included. The credit is one receipt
per table edition, named `<ref> (<version>)`, with the notice kept verbatim as
`attributionText` and the credit linking the table's licence.

It is credited under the record's own feed id rather than a source of its own.
The table reaches OpenMapX only inside that feed's records and OpenMapX contacts
no one for it, so it adds no data flow, privacy disclosure or legal-table row;
like an aggregator's upstream publisher, it is a distinct receipt under the
feed it came through. Map overlays therefore show it only while a record placed
with it is drawn.

`license` is an id, not a captured definition. An SPDX id becomes that grant;
an OpenConditions custom licence OpenMapX knows becomes OpenConditions' own
definition (namespace `openconditions:licences`); any other id is kept as an
`unknown` licence with the id as stated. No placement policy is captured, so the
notice stays visible on every surface. Tables credited this way today:

| Table                                                                     | Used for                                                    | Licence                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| DGU _Upravne jedinice INSPIRE_ (State Geodetic Administration of Croatia) | Croatian county outlines of MeteoAlarm warnings, simplified | `LicenseRef-OD-HR`, [Otvorena dozvola / Open Licence (Croatia)](https://data.gov.hr/otvorena-dozvola) |
| TMC location code lists, such as BASt's LCL for Germany                   | Road events placed by Alert-C code                          | As the list states, such as `CC-BY-4.0`                                                               |

The Croatian Open Licence asks for the source, the date, a link to the dataset
and a mark of changes with the data. OpenConditions writes all four into the
notice, so OpenMapX shows it unaltered.

## Attribution placement

The producer stores source/product requirements on
`licensing.bindings[].attribution`, and captures them **before acquisition** with
that record. Built-ins declare overrides in the exact manifest source binding;
OpenConditions declares `attributionPolicy` on the exact feed (or a reviewed
custom licence definition), then copies it into that binding before publication.
No database column, migration, global source-ID lookup or executable extension
callback is needed. Cached data keeps its captured terms through refresh failures
and catalogue changes.

The shared `@openmapx/mobility-core/attribution-placement` resolver supplies
reviewed defaults for exact SPDX grants. CC BY/BY-SA 4.0, DL-DE-BY 2.0, NLOD 2.0,
OGL 3.0 and other explicitly reviewed grants allow directly associated details.
All atoms in `AND`/`OR` expressions must support that placement: presentation
never selects an `OR` branch for the producer. Older/ported CC, ODbL, unknown,
per-item and unreviewed custom terms remain visible by default. Software scope
belongs in details and grants no rights to its sibling data. Public-domain data
may omit named copyright credit, but separate API/service terms still apply.
These defaults do not approve commercial use or redistribution.

A provider override takes precedence **only on its listed display surfaces**:
`map`, `content`, or `image`. Review the exact product, plan and agreement, not
just the licence label. For example, OpenMapTiles schema, OSM's deliberately
retained compact credit, MapTiler branding, DWD/Open-Meteo adjacency,
OpenWeather branding, MeteoAlarm source identification and Windy courtesy links
have source-specific treatment. Missing/private agreements stay unresolved and
visible; visible credit cannot cure a missing usage grant.

```json
{
  "placement": "visible",
  "surfaces": ["map", "content"],
  "basis": "provider-terms",
  "reviewedAt": "2026-10-14",
  "evidenceUrls": ["https://example.com/terms"],
  "reason": "The provider requires its linked name beside the displayed data",
  "compactText": "© <a href=\"https://example.com/\">Example publisher</a>"
}
```

Every override requires dated evidence and a reason. `compactText` certifies an
actual permissible minimum; omit it if full wording must remain visible. The
full original notice, author/publisher, licence links, conditions, modifications,
notes and receipt time remain in the directly accessible attribution dialog.
`basis: "unresolved"` cannot authorize details or abbreviated wording. Optional
`includePublisher: true` keeps the actual captured record publisher adjacent to
the service notice (for example, a warning's national issuing service).
`prominence: "normal"` preserves a provider's ordinary-text-size requirement.
`logo` selects an approved local asset (`openweather`, `mapillary`, `maptiler`,
`tdx`); arbitrary remote assets cannot be requested through this metadata. Adding
branding requires a reviewed host asset and source policy.

`buildAttributionPresentation(receipt, surface)` and
`projectAttributionPresentations` are the common safe renderer and union for
maps, content and images. They preserve the strictest visible requirement,
distinct notices, every unambiguous publisher/licence link, and required branding.
Publisher-name prefixes are not duplicate credits. Required logos also remain
visible in the details dialog when it covers their original map/image strip.
Use the host's `AttributionStrip` for content and its rendered/raster registration
helpers for maps. `maxVisible` limits optional provenance chips only. For compact
image surfaces such as the navigation junction card, `provenanceDisplay="details"`
keeps optional provenance in the common dialog while required image notices and
logos remain adjacent and wrap. Keep attribution controls outside the
noninteractive `role="img"` graphic and key both the photo and its credit strip
by provider and image identity so a new image resets measured framing and open
details. Capture date is separate from the authoritative image receipts, including
an explicitly empty list. A hover
hint or global `/licenses` page is not a replacement for the current, one-action
full attribution dialog. Do not implement source-name checks in view components.

Images keep their actual creator, file page, file licence and embedded
watermarks. Capture API/service obligations separately; a platform manifest is
not the grant for an individual photograph. Built-in photo/imagery acquisition
uses `capturePhotoProviderContributors` or the explicit-source
`captureStreetLevelProviderContributors`. Camera views/sections retain their own
contributors so an image does not borrow a neighbouring camera's branding.
Panoramax adapters share `panoramaxAuthor` from `@openmapx/core`; producer-role
provider metadata precedes the string `geovisio:producer`, and absent creators
stay unknown.
External embedded players retain their own branding and load under the existing
consent boundary.

All map surfaces retain required notices without clipping, ellipsis or a hidden
scroll area. Eligible complete notices move into a labelled details dialog with
keyboard/touch access and focus restoration. An arbitrarily large mandatory
list cannot fit any finite viewport: the main footer keeps the notices readable
and offers layer management when they exceed a quarter of usable map height.
It does not silently hide data or required credits. Exports, recordings and
screenshots need their own source-specific review because an interactive dialog
is unavailable there.
