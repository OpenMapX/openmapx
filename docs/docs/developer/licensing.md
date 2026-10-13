---
title: Licence metadata
---

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
`attributionText` remains the publisher's original required notice.

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
viewport and zoom rules. This contract does not itself decide whether a notice
may move to a details panel.
