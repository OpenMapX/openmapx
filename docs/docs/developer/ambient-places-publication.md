---
title: Ambient place publication
description: Bounded regional place generations, canonical identities and the MVT/PMTiles serving decision.
---

# Ambient place publication

`overlay-ambient-places` shows destinations during ordinary map browsing. It consumes
one published German region; source ingestion remains in the existing OSM search
index and Overture workflows. The existing OSM extractor requires an alias, code
or generated acronym term: a source-present name-only object can therefore be
absent from this index and layer. This coverage limit is distinct from label
collision or ambient ranking. The initial operator form targets Aachen. Nothing
imports planet data, calls AllThePlaces directly, or changes geocoding.

## Operator workflow and public contract

1. Build the regional OSM search index using the existing data workflow. Its state
   must be `ready`, with a publication timestamp no older than 90 days.
2. Optionally complete Overture Places ingestion and conflation for the installed
   release. An absent or empty, uninitialized Overture source permits OSM-only
   publication; populated, unfinished, mismatched or stale sources fail closed.
3. In **Admin → Services → Data workflows → Nearby places**, choose a name and
   bounding box. Bounds must fit Germany's rollout envelope
   `[5.8,47.2,15.1,55.1]`, span at most 0.5 degrees in either direction and contain
   at most 100,000 OSM rows including linked boundary counterparts, and 100,000
   Overture rows. The combined result also cannot exceed
   100,000 places.
4. Publish and refresh the status card. It shows active/previous generation,
   source region/epoch/release, dates, counts and errors. Build acceptance is
   asynchronous (`202`) after acquiring the publication writer lock; acceptance is
   not proof that publication succeeded. Competing requests receive `409`. Status
   writes share the writer lock and attempt identity, so a rejected request cannot
   overwrite or abort the admitted publication. While `building` is true,
   external status readers can still see the prior completed attempt's dates or
   error until the candidate transaction commits.
5. Use **Disable** for discovery fallback, **Enable** to resume, or **Roll back**
   to switch to the predecessor. Rollback can be repeated to switch back.

The authenticated admin proxy routes are
`/api/admin/ambient-places/{status,build,enabled,rollback}`. Their data-manager
counterparts omit `/api/admin`. Mutations use the existing administrator guard,
audit log and validated, bearer-authenticated data-manager connection. Public
clients read `/api/ambient-places/manifest` (`no-store`), then
`/api/ambient-places/tiles/<generation>/<z>/<x>/<y>.mvt`. Errors are not cached;
valid tiles are immutable for seven days. Unknown generations return `404`.

The public manifest contains only generation/policy version, publication time,
region bounds/name, counts and source release provenance. Source filesystem
paths/fingerprints, contributor record IDs and raw ingest state are not exposed.
Source publication time means local snapshot publication, not real-world
verification of every business. The UI identifies OSM-only versus combined
coverage. Filters, missing source coverage, ranking and collisions remain visible
limits; the layer is not a complete business directory.

## Publication, retention and identity

A dedicated `ambient_places` schema isolates snapshots from mutable source tables.
The OSM index writer stores tag objects as JSONB; ambient policy also reads older
serialized-object rows, and rejects malformed/non-object policy tags so closure
and private-access checks cannot silently disappear.
A repeatable-read transaction holds an advisory writer lock, reads bounded indexed
source candidates, applies the shared policy and writes batches of 500 places.
Generation and feature insertion, count validation and the active/previous pointer
swap commit together. Any failure rolls them all back. Concurrent writers fail
without exposing a partial generation. There is no dependency on a background
planet import or a live source-table query at map-render time.

Projected points are stored as EWKB bytes with a functional GiST index on
`ST_GeomFromEWKB(geom)`. This keeps the internal generation store out of Martin's
automatic spatial-table discovery: an unversioned table endpoint would otherwise
bypass the API's generation and read budgets. Tile queries decode the indexed
geometry before MVT encoding. Existing Martin sources and configuration are
unchanged.

Generation URLs never change their bytes when sources refresh. At most eight
snapshots are retained. Unreferenced generations can be removed only after their
cache lease expires. The lease renews when leaving active discovery or rolling
back, covering seven days plus the one-minute discovery refresh interval from
that transition, regardless of the original publication date. Active and previous
are preserved. If all slots still have cache leases,
publication refuses another build. Disable changes discovery within the client's
one-minute refresh interval; it does not revoke previously downloaded tiles.
Clients keep a fresh last-good manifest on temporary discovery failure and remove
an explicitly disabled or over-age publication. No published region means ordinary
basemap browsing.

Accepted OSM↔GERS links determine identity: `osm:<type>/<id>` remains primary and
GERS remains an alias. Overture-only places use `overture:<GERS>`. Bigint OSM IDs
remain strings throughout SQL, tiles, search and details. OSM field values win;
Overture fills missing names and unmatched coverage. A known excluded OSM match
cannot be resurrected by its Overture counterpart. Linked OSM counterparts are
read and evaluated even across the bbox boundary, within the same OSM input cap.
Authoritative OSM locations outside the chosen region omit the pair; they do not
become an Overture gap with lost closure or tenant policy. Tiles carry canonical ID, GERS,
localized names, category, rank, minimum zoom, tenant flag and source combination.

The client suppresses ambient features already owned by a category/selection ID.
An owned-basemap label can acquire the canonical identity only through an explicit
OSM ID or, only when no explicit identity is supplied, a unique compatible-category/name
match within ten metres. Worship matching uses its destination class, not the religion subclass. An explicit different OSM identity is never replaced
by proximity. Ambiguous
branches and non-ground tenants are not matched by proximity. Mappings belong to
the map instance and are cleared on style replacement and overlay teardown. The
existing place-card conversion/resolver handles both tile and basemap clicks.
When the optional Overture search provider has no registered resolver, the place
API resolves a matching GERS alias from the fresh published ambient snapshot,
retaining canonical OSM/GERS identity and supplied names. Its existing detail
cache key includes that generation. Discovery disable does not revoke snapshot
identities already exposed in cached tiles. The richer live Overture metadata
continues to use the enabled provider; unpublished disabled-provider deep links
retain their existing coordinate fallback.

## Policy and read budgets

- OSM: named valid points, no explicit closed/disused/abandoned/demolished/removed
  or private-access records. Non-ground level/floor records start at zoom 18.
- Overture: named valid points, known `open` status and finite confidence ≥0.5.
  Missing values are omitted. Unsupported contributor datasets block publication.
- Labels: supplied German/English names, otherwise the source name; at most 120
  Unicode characters. No inferred opening hours, ratings or popularity.
- Ranking (policy 2): essential destinations at zoom 13; corroborated cathedral/
  basilica or heritage levels 1–3 destinations at 14; other registered cultural
  landmarks and everyday businesses at 15; other places at 16. Cultural landmarks
  require a valid Wikidata/language-prefixed Wikipedia identity plus registered
  heritage or explicit cathedral/basilica designation. Ordinary worship buildings
  without that evidence stay at 16. Importance orders within utility tiers;
  exact source ID breaks ties. Both indexed `amenity/hospital` and legacy
  `amenity:hospital` categories normalize to the same tier.
- Tenant handling: interior/node/building-part non-ground records stay at 18.
  A corroborated whole cultural-building footprint is a building destination;
  its level metadata does not imply an interior tenant or an entrance claim.
- MVT: zooms 13–18, at most 256 features, 128 KiB, indexed geometry intersection,
  a 2-second SQL timeout and eight pending tile requests per API process. A
  conservative UTF-8 budget removes the lowest-ranked tail before encoding; a
  final byte guard prevents an oversized response. Invalid UUID/XYZ never reaches
  a tile query. The vector source also declares publication bounds and zooms.

The overlay uses the existing attribution registry with OSM, Overture and supported
contributors' license/copyright notices. It does not infer a single license for
the conflated dataset. Tiles are rendered locally; there are no request-time calls
to Overture or its contributors.

## Serving comparison and decision

Both alternatives use the same canonical policy and MVT content:

| Choice                        | Publication/operations                                                                | Reads                                            | Tradeoff                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Regional PMTiles              | Precompute covered cells, verify archive, stage immutable file and switch discovery   | Static range reads or Martin archive ZXY         | Portable/offline-friendly; requires an archive builder, tile enumeration and file/object lifecycle      |
| Existing Martin + PostGIS MVT | Publish immutable rows and serve a generation-specific SQL function                   | Martin cache in front of indexed PostGIS         | Existing service; direct auto-published tables/functions need explicit generation routing and budgets   |
| Implemented API + PostGIS MVT | Same immutable PostGIS representation with validated generation/XYZ and bounded reads | Existing API cache headers and PostGIS functions | Adds SQL work for uncached reads; keeps failure/concurrency/size guards in the established API boundary |

For this first online region, the API/PostGIS path avoids adding a second storage
publication pipeline while preserving the same MVT representation Martin can
serve. Directly exposing the mutable source tables would not provide immutable
generation URLs or these limits. PMTiles is a good candidate for a later regional
export/offline package; this change does not promise that feature.

A local disposable PostGIS 18 / PostGIS 3.6 fixture check on 2026-10-07 used 26
explicitly synthetic Aachen places, 60 occupied cells over zooms 13–18 and
identical decoded MVT bytes. The same bounded query was served through the
repository-pinned Martin image and an archive converted/verified with the official
PMTiles CLI 1.31.2. The archive was 16,451 bytes; exporting its 60 source tiles took
556 ms. For one 215-byte zoom-18 tile, first-request and 20 repeated-request
measurements were (using the prototype native-geometry storage before the final
EWKB discovery safeguard):

| Serving path   | First request | Warm median | Warm p95 |
| -------------- | ------------: | ----------: | -------: |
| API/PostGIS    |      77.40 ms |    10.04 ms | 20.14 ms |
| Martin/PostGIS |      19.27 ms |     3.31 ms |  4.27 ms |
| Martin/PMTiles |       5.55 ms |     1.42 ms |  2.87 ms |

The final store uses the same projected points and MVT query with EWKB decoding
and its functional spatial index; the table above does not measure that final
storage representation. Its bounds, decoded tiles and details lookup are checked
by the real PostGIS regression suite.

These are local fixture observations under concurrent development load, not
production capacity estimates. They do not measure a full regional archive,
remote range requests, CDN misses, a restarted cold database, or mobile FPS. The
20 Martin repeats benefit from its response cache. A separate 1,000-place dense
PostGIS fixture emitted 256 features / 14,805 bytes, with prototype p95
SQL/repository reads of 6.75 ms over 20 repeats. The same regression fixture with
final EWKB storage on 2026-10-08 measured 3.57 ms p95 and identical feature/byte
counts; differing local load prevents treating this as a speed comparison.
The prototype single-place fixture published in 144 ms and
produced a 214-byte tile. Long multilingual UTF-8 labels verified the byte budget
by reducing the feature count below 256. Reproduce behavior with:

```sh
OPENMAPX_RUN_DATABASE_TESTS=1 pnpm exec vitest run services/data-manager/__tests__/ambient-places/publish-postgres.test.ts
```

Official references: [PostGIS MVT](https://postgis.net/docs/ST_AsMVT.html),
[tile envelopes](https://postgis.net/docs/ST_TileEnvelope.html),
[Martin PostGIS functions](https://maplibre.org/martin/sources-pg-functions/),
[Martin configuration](https://maplibre.org/martin/config-file/), and
[PMTiles CLI conversion/verification](https://docs.protomaps.com/pmtiles/cli).

A native-browser development check at 1280 × 800 used 1,006 synthetic places
around Aachen. At zoom 16, 908 rendered point features competed for 83 visible
labels; MapLibre collision placement reduced the labels without reducing the
underlying places. A short 1.8-second pan/zoom sweep with the overlay had a median
animation-frame interval of 8.3 ms, p95 of 9.2 ms, and one interval over 50 ms.
The same sweep with the overlay disabled measured 8.4 ms / 17.4 ms and two
intervals over 50 ms. This single local development sample checks responsiveness
and collision behavior; it is not a statistically controlled production or
mobile benchmark. An initial background-tab sample was discarded because browser
throttling made it unsuitable for frame measurement.

Tests cover closure/confidence/tenant/label policy, accepted identities, ambiguous
matching, actual MVT decoding, input/dense-byte bounds, failed writes, contributor
refusal, stale/unfinished sources, concurrency, retention, immutable bytes,
rollback, API auth/cache/budgets and client generation/tap/style/teardown behavior.
The earlier browser evidence used clearly labeled synthetic fixtures. The regional
acceptance run below uses a real OSM extract in a disposable database; it does not
claim production Aachen coverage.

## Real regional acceptance: October 8, 2026

The follow-up uses dated, public Geofabrik Düsseldorf/Cologne October 6 PBFs,
merged and cropped to `[6.58,50.89,7.07,51.31]`. The existing extractor/index builder
produces 14,232 unique indexed places, then policy 2 publishes 13,454 places.
Uncategorized indexed roads/buildings remain searchable but are excluded from the
ambient destination layer; the real Industriestraße road-segment case is a regression
control.
The cropped source fingerprint is
`sha256:c18cc77ed3493aa186bd7659fee4a9b028fbc479c2a8a90f219a3b2d33824d75`.
The source snapshot's latest object timestamp is `2026-10-06T20:09:52Z`;
the publication timestamp is a separate pipeline timestamp.

This run has **OSM-only coverage**. Optional Overture/confidence/conflation and
published-GERS detail resolution are covered by the PostGIS regression fixtures,
not claimed as a live Overture extract. Single-name source features without aliases
or codes can be absent from the existing alias/code-focused search index. The
committed landmark corpus distinguishes source presence from index eligibility;
this change preserves that existing ingestion/geocoder behavior.

Actual Quirinus-Münster (`osm:way/28562993`) and Cologne Cathedral
(`osm:way/4532022`) publish at zoom 14 through corroborated source tags.
Names still compete for available space: eligibility does not guarantee a label
in every camera. Eight candidate anchors allow a corroborated landmark name to use nearby
whitespace while retaining collision avoidance and road/transit priority. Ordinary
destinations retain one label position to bound placement work and crowding.
The selected/category/basemap suppression filter is repaired per live layer after
paint-only theme recreation as well as full style replacement. OSM-only publication
credits use the actual OSM source; combined publications retain the supported
Overture contributor notices.

The actual extractor-to-index-to-publication run also caught JSONB-array tag
serialization: serialized strings had been stored as JSON strings rather than
objects. The index writer now casts text values once to JSONB objects, and ambient
policy safely reads legacy serialized objects. Private/closed legacy tags therefore
remain enforceable without a global migration.

The [aggregate acceptance evidence](https://github.com/OpenMapX/openmapx/blob/main/docs/docs/developer/ambient-places-acceptance.json) records
source hashes, runtime/settings, measured targets, fixed camera outcomes and
external screenshot checksums. It contains no screenshot binaries or credentials.
Selected real before/after and iOS screenshots are attached directly to PR #436.
Frames and native iOS images use generation `b900c5b5`; the final static matrix,
desktop/admin images and quiet tile reads use restored generation `6fa7e3bb`.
Both contain the same 13,454 places from the identical source hash, policy and
tested product files. Generation IDs and source epochs remain explicit in the
evidence. T3 preview handled initial static/frame QA; after `preview_open`
explicitly reported unavailable, isolated headless system Chrome completed the
static matrix and desktop/admin captures. It was not used for frame timings.

| Regional check                           | Declared limit |   Observed |
| ---------------------------------------- | -------------: | ---------: |
| Publication after indexing               |           60 s |    0.490 s |
| First repository tile read               |       1,000 ms |   28.35 ms |
| Warm sparse/dense p95, 30 reads          |         100 ms |    5.20 ms |
| Eight concurrent reads p95, 40 reads     |         250 ms |   39.34 ms |
| Representative tile features / bytes     |  256 / 131,072 | 83 / 6,881 |
| Explicit IDs duplicated in decoded tiles |              0 |          0 |

A concurrent build/test run reached warm p95 127.89 ms, exceeding the 100 ms
budget; those samples remain in the aggregate as a diagnostic. The table is the
subsequent quiet repeat on the same generation, without those jobs.

These reads measure the final EWKB/functional-GiST store in disposable PostGIS
18/PostGIS 3.6. They do not measure a restarted cold database, remote network/CDN,
a full regional PMTiles archive, or deployment capacity. On the same real source,
replacement publication preserved old bytes; forced candidate failure retained
active discovery; rollback restored the old pointer; disable hid discovery while
already published tile bytes remained readable.

Reproduce extraction/publication with the existing commands against a disposable
database, using the source SHA-256 and bbox above:

```sh
osmium merge duesseldorf-regbez-261006.osm.pbf koeln-regbez-261006.osm.pbf -o merged.pbf
osmium extract -b 6.58,50.89,7.07,51.31 merged.pbf -o rhine.osm.pbf
# Register the cropped PBF in the data-manager StateStore, then run its existing
# buildOsmSearchIndex and buildAmbientPlaces jobs against the disposable database.
OPENMAPX_RUN_DATABASE_TESTS=1 pnpm exec vitest run services/data-manager/__tests__/ambient-places
```

Osmium's complete-way crop can include object geometries outside the bbox;
publication enforces the requested region bounds. The test-only corpus contains
selected public policy/name tags with ODbL credit, not contact or contributor data.
The source PBFs omit user/UID/changeset metadata.

The fixed-camera matrix contains 45 off/on pairs at zooms 14–18: Neuss, Cologne,
sparse Zons, an empty rural cell, and no-region Aachen/Berlin/Monschau controls,
plus owned-dark English Neuss and German Cologne. Each pair has identical road
name and basemap POI identity lists; decoded tiles and visible ambient label lists
have no duplicate explicit IDs. A native pointer tap opens Quirinus-Münster with
canonical ID `osm:way/28562993`; selected-label suppression survives both paint-only
theme recreation and full style replacement. English/German fields conservatively
fall back to the source name. External enrichment is disabled in the QA fixture.
The actual admin component shows the real generation, policy 2, source coverage
and the intentionally induced failed-build notice while retaining the active map.
Its rendering fixture bypasses outer production authentication; API authorization
is verified separately by regression tests.

Five foreground five-second camera sweeps per state alternate Neuss/Cologne at
zoom 15 → 15.7 → 15 using two 2.5-second `MapLibre.easeTo` legs. RAF observes frame
intervals without forcing a camera update on each frame. Nearest-rank p95 is
computed over the pooled intervals per state; individual sweep p95s are also
recorded in the aggregate evidence. No builds/tests ran concurrently.

| Production-asset viewport                | Off pooled p95 | On pooled p95 | On >50 ms |
| ---------------------------------------- | -------------: | ------------: | --------: |
| T3 desktop, 1280 × 800                   |         9.0 ms |        9.0 ms |        0% |
| T3 phone CSS, 430 × 932                  |         9.2 ms |        9.3 ms |        0% |
| iPhone 18 Pro simulator Safari, isolated |          32 ms |         33 ms |    0.181% |
| Same simulator, live stream active       |          33 ms |         34 ms |        0% |

The isolated run pauses the device preview stream and removes our second QA
WebGL map. A paused-stream run with that second map still present reached
35/36 ms off/on; it remains diagnostic evidence alongside the streamed results.
No unrelated host process was stopped. The phone-CSS off iteration 0 was repeated
after its initial viewport resize had not settled; the original sample is retained
externally.

The unchanged target is pooled p95 ≤33.4 ms and intervals >50 ms ≤5%.
The isolated simulator run meets it; the streamed run narrowly misses the
p95 target, and individual isolated on sweeps reach 34–35 ms. This is a
qualified local simulator result, not a claim that every sweep or physical device
passes. An earlier forced-`jumpTo`-every-RAF stress workload missed mobile targets
in both states; those raw samples remain external and are not relabeled as normal
app camera behavior. Physical-device thermal/battery behavior and deployed
network/CDN latency remain rollout checks.
