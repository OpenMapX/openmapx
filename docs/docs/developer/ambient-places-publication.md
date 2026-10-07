---
title: Ambient place publication
description: Bounded regional place generations, canonical identities and the MVT/PMTiles serving decision.
---

# Ambient place publication

`overlay-ambient-places` shows destinations during ordinary map browsing. It consumes
one published German region; source ingestion remains in the existing OSM search
index and Overture workflows. The initial operator form targets Aachen. Nothing
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
   at most 100,000 rows from either source. The combined result also cannot exceed
   100,000 places.
4. Publish and refresh the status card. It shows active/previous generation,
   source region/epoch/release, dates, counts and errors. Build acceptance is
   asynchronous (`202`); acceptance is not proof that publication succeeded.
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
A repeatable-read transaction holds an advisory writer lock, reads bounded indexed
source candidates, applies the shared policy and writes batches of 500 places.
Generation and feature insertion, count validation and the active/previous pointer
swap commit together. Any failure rolls them all back. Concurrent writers fail
without exposing a partial generation. There is no dependency on a background
planet import or a live source-table query at map-render time.

Generation URLs never change their bytes when sources refresh. At most eight
snapshots are retained. Unreferenced generations can be removed only after seven
days; active and previous are preserved. If all slots still have cache leases,
publication refuses another build. Disable changes discovery within the client's
one-minute refresh interval; it does not revoke previously downloaded tiles.
Clients keep a fresh last-good manifest on temporary discovery failure and remove
an explicitly disabled or over-age publication. No published region means ordinary
basemap browsing.

Accepted OSM↔GERS links determine identity: `osm:<type>/<id>` remains primary and
GERS remains an alias. Overture-only places use `overture:<GERS>`. Bigint OSM IDs
remain strings throughout SQL, tiles, search and details. OSM field values win;
Overture fills missing names and unmatched coverage. A known excluded OSM match
cannot be resurrected by its Overture counterpart. Tiles carry canonical ID, GERS,
localized names, category, rank, minimum zoom, tenant flag and source combination.

The client suppresses ambient features already owned by a category/selection ID.
An owned-basemap label can acquire the canonical identity only through an explicit
OSM ID or a unique compatible-category/name match within eight metres. Ambiguous
branches and non-ground tenants are not matched by proximity. Mappings belong to
the map instance and are cleared on style replacement and overlay teardown. The
existing place-card conversion/resolver handles both tile and basemap clicks.

## Policy and read budgets

- OSM: named valid points, no explicit closed/disused/abandoned/demolished/removed
  or private-access records. Non-ground level/floor records start at zoom 18.
- Overture: named valid points, known `open` status and finite confidence ≥0.5.
  Missing values are omitted. Unsupported contributor datasets block publication.
- Labels: supplied German/English names, otherwise the source name; at most 120
  Unicode characters. No inferred opening hours, ratings or popularity.
- Ranking: essential destinations at zoom 13, everyday businesses at 15, other
  places at 16; utility tier and OSM importance, then stable ID tie-breaking.
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
measurements were:

| Serving path   | First request | Warm median | Warm p95 |
| -------------- | ------------: | ----------: | -------: |
| API/PostGIS    |      77.40 ms |    10.04 ms | 20.14 ms |
| Martin/PostGIS |      19.27 ms |     3.31 ms |  4.27 ms |
| Martin/PMTiles |       5.55 ms |     1.42 ms |  2.87 ms |

These are local fixture observations under concurrent development load, not
production capacity estimates. They do not measure a full regional archive,
remote range requests, CDN misses, a restarted cold database, or mobile FPS. The
20 Martin repeats benefit from its response cache. A separate 1,000-place dense
PostGIS fixture emitted 256 features / 14,805 bytes, with p95 SQL/repository reads
of 6.75 ms over 20 repeats. The single-place fixture published in 144 ms and
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
Browser evidence uses clearly labeled disposable fixtures; it does not claim
verified production Aachen coverage.
