---
title: Regional camera data audit
description: A reproducible, local-file ALPR tagging audit and cautious Aachen pilot decision.
---

# Regional camera data audit

This is the first bounded research pass for [#407](https://github.com/OpenMapX/openmapx/issues/407).
It adds a local-file audit and an **unverified awareness GeoJSON export**, not a
production camera layer or routing option. Its only network access was a manually
requested regional snapshot. The CLI itself never fetches data or opens cameras.

The decision for the sampled Aachen region is **go for a small offline awareness
prototype; no-go for production awareness or route avoidance**. One usable tag
record does not establish useful road coverage. The snapshot is old, the retained
camera is tagged for parking, and neither physical position nor continued presence
was independently verified. Empty results would mean no eligible mapped records
in that snapshot, never that a place has no cameras.

## Existing behavior and source choice

At the starting revision `bf47e937a2457f4a2539bcf43d1bf043ccea7248`,
`integrations/webcam/providers/osm.ts` requests nodes with `contact:webcam` or
`man_made=surveillance` plus `surveillance:type=webcam`. The routing integration's
OSM alerts identify speed cameras, railway crossings, stop signs and traffic
calming. Neither is an ALPR adapter. This audit changes neither path.

[DeFlock](https://github.com/FoggedLens/deflock) is a useful reference for OSM-based
ALPR awareness; its README points to the separate map project. This pilot requests
OSM directly, does not scrape DeFlock or copy its implementation, and does not
mistake software licensing for data licensing. OSM data requires attribution and
is distributed under ODbL, including applicable share-alike obligations.
[OpenStreetMap licensing](https://www.openstreetmap.org/copyright) is the primary
source for those terms; keep attribution and the data-license link with exports.

The [OSM ALPR tagging guidance](https://wiki.openstreetmap.org/wiki/Tag:surveillance:type=ALPR)
describes explicit surveillance/ALPR tags, node positions, viewing direction and
parking versus traffic zones. The auditor accepts only explicit
`man_made=surveillance` + `surveillance:type=ALPR` nodes. General CCTV, speed
cameras and webcams never become ALPR by proximity or camera brand. Lifecycle
or contradictory tags exclude a candidate. Dome/PTZ devices need independent
classification rather than an automatic promotion. Ways/relations are counted
as unsupported geometry; their centers are not treated as surveyed devices.

## Pinned acquisition

Region selected before fetching: Aachen urban area, also represented in the
[map baseline](./map-comparison-baseline.md), bbox
**west 6.04, south 50.75, east 6.13, north 50.80**. This deliberately bounded
German sample supports no national or worldwide inference.

```overpass
[out:json][timeout:25][maxsize:5242880];
(
  nwr["man_made"="surveillance"](50.75,6.04,50.80,6.13);
  nwr["surveillance:type"="ALPR"](50.75,6.04,50.80,6.13);
  nwr["highway"="speed_camera"](50.75,6.04,50.80,6.13);
  nwr["contact:webcam"](50.75,6.04,50.80,6.13);
);
out meta center;
```

The first `overpass-api.de` request returned HTTP 406, not an empty dataset. After
waiting more than 30 seconds, a request to the
[officially listed alternative instance](https://wiki.openstreetmap.org/wiki/Overpass_API)
`https://overpass.private.coffee/api/interpreter` succeeded. Client timeout was
35 seconds, download cap 5 MiB, server timeout 25 seconds. The application user
agent identified this issue; there were no parallel queries or repeated global
scans. These are research-request bounds, not a production service contract.

| Evidence                   | Recorded value                                                     |
| -------------------------- | ------------------------------------------------------------------ |
| Capture completed          | `2026-10-07T01:25:38.513Z` (local download-file completion time)   |
| Snapshot base              | `2026-07-28T02:16:18Z`                                             |
| Source age at capture      | 70.965 days; source snapshot age, not last camera observation      |
| Generator                  | `Overpass API 0.7.62.11 87bfad18`                                  |
| Successful request         | HTTP 200, 91,580 bytes, 12.248 seconds                             |
| First unsuccessful request | HTTP 406, 0 bytes, 0.163 seconds                                   |
| Raw response SHA-256       | `a11a8d16294cdb80aa2b5fa76eaafe755815f83e283ddb1c14564ee636453ac6` |
| Exact query SHA-256        | `4a01887e90abb06e6bf19b52f1940cdfe34654874bf1d71079361b289a6e4272` |

The exact query, response, request costs, review file and generated outputs are
archived as an external attachment on the implementation PR linked from #407.
The repository contains synthetic tests, not the raw snapshot or screenshot
folders. Later source edits must produce a new archive/hash and version-matched
review; silently replacing this snapshot invalidates the comparison.

## Findings and uncertainties

239 objects were returned, all nodes. Mutually exclusive tag categories were
**2 explicit ALPR, 7 speed cameras, 1 webcam and 229 other surveillance**. Three
objects had `disused=yes`; 215 object edit timestamps predated October 7, 2025.
Neither count establishes physical removal or field-survey age.

| Source identity / version                         | Tag evidence                                                                           | Disposition                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `node/10249524133` / 1                            | ALPR for parking-duration enforcement; note explicitly says actual position is unknown | Excluded by versioned review; viewing direction unknown                                        |
| `node/13866874216` / 1                            | Explicit ALPR, parking zone, `direction=270;90`, edited May 23, 2026                   | One awareness point; two direction values retained, physical position/type/presence unverified |
| `node/496281248` / 8                              | Highway speed camera with traffic-signal subtype and direction 10                      | Speed camera, never ALPR; current routing alert behavior unchanged                             |
| `node/4076411209` / 5                             | Webcam type                                                                            | Webcam, never ALPR                                                                             |
| `node/469105024` / 3                              | Surveillance with `disused=yes`, edited in 2017                                        | Not an active ALPR point; actual removal unknown                                               |
| `node/12037705544` / 1 and `node/12037705545` / 1 | Generic cameras within about 0.2 m, different directions 187/336                       | Distinct records; proximity does not establish duplicates or ALPR                              |

Both explicit ALPR records were inspected for tags and edit metadata. No field
survey, independent current photograph, operator confirmation or historical
removal review was available. Tag precision and recall against real cameras are
**unknown**. The retained point has no independent duplicate evidence; the
export's ALPR-only 5 m pair check returns no pairs after exclusion. That does not
establish absence of duplicate or unmapped physical devices.

The export records object **edit** time separately from snapshot/capture time.
Directions prefer `direction`; numeric degrees and 16 compass points are accepted.
Multiple values stay multiple. Missing, invalid or contradictory legacy evidence
stays unknown/conflicting. No road orientation or single confident viewing cone
is inferred. Nearby ALPR records are flagged within 5 m and never merged.

## Repeat the offline audit

Download/export a permitted bounded snapshot separately, retain the exact query,
and write a review array with identities, versions, decisions (`exclude` or
`retain-unverified`) and reasons. The archived pilot contains its actual review.
For example:

```json
[
  {
    "identity": "node/10249524133",
    "version": 1,
    "decision": "exclude",
    "reason": "Source note says actual camera position is unknown."
  }
]
```

From the repository root, with Node 24 or newer:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
  scripts/camera-audit/run.ts \
  --input /path/to/response.json --query /path/to/query.txt \
  --source https://overpass.private.coffee/api/interpreter \
  --captured-at 2026-10-07T01:25:38.513Z \
  --bbox 6.04,50.75,6.13,50.80 \
  --review /path/to/review.json --out /path/to/new-output-directory

pnpm vitest run scripts/camera-audit
pnpm exec tsc -p scripts/camera-audit/tsconfig.json
```

The CLI writes `audit.json` and `awareness.geojson` only after validation, into a
new directory. It refuses existing output directories. Acquisition errors,
Overpass remarks, malformed positions/metadata, duplicate identities and stale
review versions fail; they never become empty successful coverage. A failed write
removes only the newly created output directory. Inputs and previous runs remain.

Bounds: 5 MiB per file, 10,000 objects, at most 1 degree on each bbox axis and
1,000 eligible ALPR points. The candidate pair list is capped at 1,000 and marks
truncation explicitly; subdivide dense regions. Input/query hashes and a normalized
review hash accompany the result. The CI types job checks this private script
project separately; the root type command alone checks workspace packages.

## Exposure and optional routing policy

A future **exposure estimate** could match independently verified points to route
segments using distance and explicitly uncertain viewing directions. A radius
would be an analytical assumption, not camera range. Parking cameras and unknown
orientations must not become guaranteed road exposure; multiple directions need
separate possible matches. Publish uncertainty and distinguish mapped coverage
from physical coverage.

An eventual optional **avoidance policy** must be explicitly enabled, have a
published detour ceiling, and prove that the selected engine applied it. If no
route satisfies the policy within that ceiling, return an explicit unavailable
alternative and offer the ordinary route only with the user's informed choice.
Do not silently relabel the ordinary route as avoiding cameras. Existing closure
or speed-camera options do not prove ALPR avoidance. No exposure score, route
comparison, detour claim or avoidance option is shipped by this pilot.

The pre-acquisition production gate requires an independently sampled, current
position/type/direction review (at least 95% type precision and 90% direction
completeness), then engine off/on route comparisons, policy-application evidence,
detour bounds and no-alternative fixtures. None was measured here. There is no
claim of a surveillance-free route, even after such a gate passes.

Follow-ups in #407 are narrowly ordered: obtain a recent permitted regional
snapshot and independently verify the two positions/types; determine whether
road-facing camera coverage is useful; only then build an opt-in cached overlay
using existing provider/attribution/freshness contracts. Route-policy research
comes last and requires the chosen engine's actual application proof. A fresh
snapshot or more generic CCTV markers alone cannot clear the production gate.
