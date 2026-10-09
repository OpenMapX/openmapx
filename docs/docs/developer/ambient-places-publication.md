---
title: Ambient place publication
description: Bounded global, Germany and regional place generations, canonical identities and the MVT/PMTiles serving decision.
---

# Ambient place publication

`overlay-ambient-places` shows destinations during ordinary map browsing. It consumes
one published planet, Germany or custom regional generation. Source ingestion remains
in the existing OSM search index and Overture workflows. Newly built OSM snapshots
retain allowlisted named POIs even when they have no alias/code/acronym, without
inventing lexical terms. Coverage, policy and collision limits remain distinct.
Global publication requires a complete format 2 planet snapshot; it is explicit
operator work. No AllThePlaces ingestion or geocoder rewrite is introduced.

## Operator workflow and public contract

1. Build the OSM search index for the target region using the existing data workflow. Its state
   must be `ready`, with a publication timestamp no older than 90 days.
2. Optionally complete Overture Places ingestion and conflation for the installed
   release. An absent or empty, uninitialized Overture source permits OSM-only
   publication; populated, unfinished, mismatched or stale sources fail closed.
3. In **Admin → Services → Data workflows → Nearby places**, select **Planet**, **Germany**
   or **Custom region**. Germany requires the ready OSM snapshot for
   `europe/germany` and, when Overture is initialized, the completed
   `europe/germany` Overture snapshot. A ready state for a smaller region is
   rejected. The Germany preset uses `[5.8,47.2,15.1,55.1]` and bounded source-ID
   batches; custom bounds may lie anywhere within Web Mercator, use ordered west/east coordinates, span at most 0.5 degrees in either direction and contain
   at most 100,000 OSM rows including linked boundary counterparts, and 100,000
   Overture rows. The combined result also cannot exceed
   100,000 places. Germany output is capped at 20,000,000 places.
4. Publish and refresh the status card. It shows active/previous generation,
   source region/epoch/release, dates, counts and errors. Build acceptance is
   asynchronous (`202`) after acquiring the publication writer lock; acceptance is
   not proof that publication succeeded. Germany admission also acquires shared
   OSM/Overture operation locks; busy source preparation receives `409`. Status
   writes share the writer lock and attempt identity, so a rejected request cannot
   overwrite or abort the admitted publication. While `building` is true,
   external status readers can still see the prior completed attempt's dates or
   error until the candidate transaction commits. The admitting process reports
   live country phase, processed rows, batch count and staged places separately
   from the active publication; other processes still report the writer lock.
5. Use **Disable** for discovery fallback, **Enable** to resume, or **Roll back**
   to switch to the predecessor. Rollback can be repeated to switch back.

The authenticated admin proxy routes are
`/api/admin/ambient-places/{status,build,resume,discard,enabled,rollback}`. Their data-manager
counterparts omit `/api/admin`. Mutations use the existing administrator guard,
audit log and validated, bearer-authenticated data-manager connection. Public
clients read `/api/ambient-places/manifest` (`no-store`), then
`/api/ambient-places/tiles/<generation>/<z>/<x>/<y>.mvt`. Errors are not cached;
valid tiles are immutable for seven days. Unknown generations return `404`.

The public manifest contains only generation/policy version, publication time,
region bounds/name, optional `coverage: "germany"` or `"planet"`, counts and source release provenance. Source filesystem
paths/fingerprints, contributor record IDs and raw ingest state are not exposed.
Source publication time means local snapshot publication, not real-world
verification of every business. The UI identifies OSM-only versus combined
coverage. Filters, missing source coverage, ranking and collisions remain visible
limits; the layer is not a complete business directory.

The Germany build body is:

```json
{ "name": "Germany", "bounds": [5.8, 47.2, 15.1, 55.1], "coverage": "germany" }
```

Country bounds cannot be customized with this flag. Geography is the installed
snapshot inside the rollout envelope, not political-border clipping: a
rectangular Overture extract can include neighbouring-country places. The
snapshot's region label and ingest validation provide source provenance; a
publication does not independently prove that every place in Germany is present.

## Germany preparation and resource limits

Prepare the existing OSM download/search-index and optional Overture
pull/ingest/conflation workflows for `europe/germany` before publication. No new
ingestion workflow is introduced. Sources must remain fresh and their installed
release must be consistent. OSM-only publication is supported and identified in
the admin card when no initialized Overture source exists.

The publisher reads at most 2,000 source records at once. Its first ordered pass
publishes eligible OSM places with accepted Overture counterparts; its second
publishes eligible Overture gaps. Linked OSM policy and position remain
authoritative even across envelope boundaries. Source-ID keysets preserve bigint
identity without country-sized arrays or geographic seam deduplication.

The operations agent inspects free space on the actual PostGIS volume before a
country build. Admission requires a minimum 1 GiB working allowance, or 2 KiB per
input source record if larger, plus a 5 GiB reserve. The reserve is checked every
25 batches and again before activation. These are conservative admission guards,
not measured Germany sizing or a guarantee against competing disk usage. Budget
the existing source tables, candidate/index writes, transaction logs, retained
country versions and backups separately; disk and I/O can dominate memory.

Country publication is one potentially long repeatable-read transaction. Shared
locks use the existing OSM and Overture operation keys and prevent source-schema
replacement between batches. Schedule publication after source preparation;
source update jobs can wait until it finishes. Application memory stays bounded,
but the transaction can retain old row versions and accumulate substantial WAL.
Failure or process interruption rolls back the candidate. The prior map remains
available throughout, and rollback does not require another country build.

The repository's container defaults are not national capacity guarantees. A full
Germany import, cold-cache tile tests and representative concurrent traffic on
the deployment host remain operational acceptance work. The local regression
uses 100,001 synthetic OSM places, distant city tiles and multi-batch Overture
fixtures to verify correctness; it does not measure a real national dataset.

```bash
OPENMAPX_RUN_DATABASE_TESTS=1 pnpm exec vitest run --maxWorkers=1 services/data-manager/__tests__/ambient-places/germany-postgres.test.ts
```

## Planet preparation, restart and deployment

Planet publication is an explicit workload, not an API boot task. On the chosen
preparation host, use the existing authenticated data-manager/CLI workflow in order:

```bash
pnpm openmapx data download osm planet
pnpm openmapx data search-index build planet
pnpm openmapx data search-index status
pnpm openmapx data overture-sync planet
pnpm openmapx data overture-status
```

Wait for each job to finish before the next command. Keep the same downloaded
PBF in place throughout both source builds. The OSM snapshot must be `ready`,
region `planet`, ambient source format **2**, current fingerprint equal to its
published fingerprint, and have a recorded file identity. Overture must be
region `planet`, on one validated Places release, with completed conflation
against that exact OSM file identity. Table identities, epochs, release dates,
conflation completion/attempt and row counts form the durable source signature.
Same-release reconflation also invalidates an interrupted candidate. Older OSM
snapshots need rebuilding; merely widening region bounds does not establish
worldwide coverage. Absent/empty uninitialized Overture allows explicit OSM-only
fallback. A populated invalid Overture snapshot fails closed.

In **Admin → Services → Data workflows → Nearby places**, select **Planet**,
then **Publish planet snapshot**. The authenticated build body is:

```json
{
  "name": "Planet",
  "bounds": [-180, -85.051129, 180, 85.051129],
  "coverage": "planet"
}
```

A dedicated single-connection client holds the ambient writer and shared source
operation locks between short transactions. Its idle/max-lifetime expiration is
disabled for this job; backend identity and lock ownership are checked before
transactions. Each ordered page reads at most 2,000 source rows and inserts at
most 500 features per statement. Feature insertion and checkpoint advancement
commit together. The build does not retain a planet-long repeatable-read snapshot.
Source replacement still waits for the shared locks; schedule the global build
after preparation. Only one candidate may exist. Its detached table and metadata
are invisible to public manifest, tile and GERS reads.

After a process/database interruption, status exposes the durable candidate,
phase, processed rows, staged count and last error. **Resume planet build**
continues that generation only with unchanged source signature and policy.
**Discard candidate** removes only unpublished storage, then permits a new build.
These administrator actions are validated, audited and maintenance-rate-limited.
Their proxy endpoints are `/api/admin/ambient-places/resume` and `/discard`, with
body `{"generation":"<candidate UUID>"}`; data-manager counterparts omit
`/api/admin`. Resume acknowledges admission with `202`; check status for success.
Policy/source changes require discard and rebuild. A running status after process
loss is an interrupted candidate when no writer owns the lock. Resume reacquires
all admission locks. Discard cannot remove active or retained published data.
While the writer is running, competing builds and pointer changes are refused.
To interrupt a long build deliberately, stop or restart the data-manager through
the existing service controls. Committed pages survive; connection closure
releases its source/writer locks. Inspect status before resuming, discarding or
changing discovery. There is no separate candidate-cancellation endpoint.

Each planet generation owns an indexed PostgreSQL partition with projected EWKB,
canonical ID and GERS indexes. Indexes are maintained during committed pages.
Final validation checks durable source counts/signatures, then attaches the
partition and switches discovery atomically with a one-second lock timeout.
A contention failure leaves a resumable candidate and the last good map active.
There is no planet-sized final count/index rebuild under the activation lock.
Leased generations remain available; expired unreferenced planet partitions are
dropped instead of cascading millions of row deletes. Active/previous generations
and the seven-day-plus-one-minute tile lease retain their existing guarantees.
A legacy regional/Germany installation is migrated additively, without rewriting
its existing feature rows; its previous tile URLs remain readable. New readers
also support the old feature table before migration. Dateline tiles query the
opposite edge through its spatial index and shift buffered geometries into the
requested world copy. Latitude outside Web Mercator is excluded conservatively.
Client decoding normalizes buffered world-copy longitudes before identity
reconciliation and selection; this does not relax source coordinate validation.

### Deployment scenarios

| Scenario                                      | Supported setup                                                                                                                                                                      | Operational tradeoff                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One appropriately sized host                  | Existing data-manager, ops-agent, authoritative PostGIS and API; separate source/publication schedules                                                                               | Simplest operations. Preparation competes with origin reads for RAM, disk I/O and WAL; container defaults are not a planet capacity profile.                                                                                                             |
| Dedicated preparation host and scaled origins | One data-manager with persistent `/data`, private access to the same authoritative PostGIS, and authenticated ops-agent access to that database host; multiple API origins and a CDN | Separates source-tool CPU/RAM from serving. Capacity inspection must report the actual database volume; a builder-local empty disk is not a substitute. Do not run competing builders. Source/feature SQL and WAL still consume database-host resources. |
| Immutable object storage / PMTiles            | A possible later distribution path, not an implemented exporter here                                                                                                                 | Removes most origin SQL after export, but needs generation-aware conflated tile enumeration, archive verification, object lifecycle and range/cache configuration. Raw Overture tiles cannot replace the canonical OSM/Overture policy output.           |

All implemented API origins must use the same authoritative generation database.
This change does not route individual requests to replicas or synchronize separate
publication databases. A deployment using physical database replication must
route discovery and feature reads consistently to a fully replayed instance;
never copy an active pointer ahead of its partition. Back up source metadata,
generation partitions and state together. Recover an unfinished candidate through
resume/discard; restore the last good complete database before advertising it.

A CDN may cache **only successful** generation-specific MVT responses for their
seven-day immutable lifetime. Keep discovery/status and errors uncached; existing
`Cache-Control` headers express this. Forward every generation/XYZ path component
in the cache key and preserve binary content type. Changing sources creates new
URLs. Disable changes discovery within one minute; rollback restores a retained
URL. Neither action can revoke a tile already held by a client/CDN. Preserve the
API's per-origin eight pending reads, two-second SQL timeout, zooms 13–18,
256-feature and 128-KiB budgets. Origin scaling increases aggregate database work,
so size connection limits and monitor cache misses, timeout/429 rate and query
latency instead of multiplying API processes without a database budget.

### Resource sizing and configuration

No full planet import or global-load benchmark was run on the development
machine. Plan resources from source sizes and measured indexed generation bytes,
not from the small fixture timings below. Keep separate budgets for:

- Preparation volume: current/new planet PBFs, filtered/exported files, retained
  Overture Parquet, file-backed node index and DuckDB spill. File-backed node
  locations do not make osmium area/relation assembly memory-free.
- Database volume: active sources plus next-source staging, candidate/component
  graph workspaces, retained ambient generations plus one candidate, indexes,
  peak WAL/temporary space, backups and free-space reserve. Exact label propagation
  can require many disk/SQL rounds on long connected graphs.
- Serving: ordinary bounded viewport reads, database buffer-cache working set,
  unique geographic cache misses, network egress and CDN cache hit rate. Global
  coverage expands storage/cache footprint; each request keeps the same limits.

Measure `pg_total_relation_size` for a representative indexed generation. If its
measured size is `G`, provision retained ambient storage at least `R × G + G`
for `R` retained published generations and one candidate, plus all other database
budgets above. At most eight generation slots exist, including a candidate;
leases may prevent another build. A weekly publication cadence generally retains
fewer versions than daily builds. The conservative publisher admission allowance
is **2 KiB per remaining raw source row**, minimum 1 GiB, plus 20 GiB reserve,
checked before staging, every committed page and before activation. For example,
200 million raw rows require about 381.5 GiB working allowance plus 20 GiB at the
start; this is a guard, not an estimate of final storage or peak WAL. Other writers
can still exhaust space after admission, in which case the candidate fails safely.

| Data-manager setting                 |        Default | Meaning                                                                                                                    |
| ------------------------------------ | -------------: | -------------------------------------------------------------------------------------------------------------------------- |
| `AMBIENT_PLANET_MAX_PLACES`          |    `250000000` | Positive output guard; increase only after sizing the target deployment.                                                   |
| `AMBIENT_PLANET_RESERVE_BYTES`       |  `21474836480` | Positive PostgreSQL-volume safety reserve (20 GiB).                                                                        |
| `OVERTURE_DUCKDB_MEMORY_MB`          |         `2048` | Buffer-manager limit; total RSS can exceed it.                                                                             |
| `OVERTURE_DUCKDB_THREADS`            |            `4` | Preparation parallelism, validated 1–64.                                                                                   |
| `OVERTURE_DUCKDB_TEMP_MB`            |        `32768` | Maximum per-process spill (32 GiB); allocated in a unique directory under `/data/overture/duckdb-tmp`, removed after exit. |
| `OSMIUM_PLANET_INDEX_ESTIMATE_BYTES` | `137438953472` | File-backed node-index admission allowance (128 GiB), plus 5 GiB free on the source volume; adjust for the selected PBF.   |

These settings are forwarded by the data-manager service manifest and can be set
through its existing deployment configuration. Increase the service's memory/CPU
resource limits separately for full source preparation; its 8-GiB default is not a
planet preparation promise. Overture pull admission additionally uses 512 bytes per
selected STAC row as a working allowance; ingest/conflation apply their existing
database guards. Exact assignment admits at most 512 nodes per side and 50,000 edges
per component; dense neighborhoods are bounded too. Oversized source clusters
fail closed and require investigation, rather than silently dropping matches.

The approach follows [OSM planet distribution](https://planet.openstreetmap.org/),
[Overture cloud sources](https://docs.overturemaps.org/getting-data/cloud-sources/),
[osmium index types](https://docs.osmcode.org/osmium/latest/osmium-index-types.html),
[DuckDB resource settings](https://duckdb.org/docs/current/configuration/overview),
[PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html)
and [partitioning](https://www.postgresql.org/docs/17/ddl-partitioning.html).
The object-storage alternative follows the
[PMTiles deployment model](https://docs.protomaps.com/deploy/); it remains a separate
export/distribution decision.

## Publication, retention and identity

A dedicated `ambient_places` schema isolates snapshots from mutable source tables.
The OSM index writer stores tag objects as JSONB; ambient policy also reads older
serialized-object rows, and rejects malformed/non-object policy tags so closure
and private-access checks cannot silently disappear.
For regional/Germany publication, a repeatable-read transaction holds an advisory writer lock, reads bounded indexed
source candidates, applies the shared policy and writes insert batches of 500 places.
Generation and feature insertion, count validation and the active/previous pointer
swap commit together. Any regional/Germany failure rolls them all back. Planet publication uses the durable batches and detached partitions described above. Concurrent writers fail
without exposing a partial generation. There is no automatic background
planet import or a live source-table query at map-render time.

Projected points are stored as EWKB bytes with a functional GiST index on
`(generation, ST_GeomFromEWKB(geom))`. The standard PostgreSQL `btree_gist`
extension supplies UUID indexing and is installed by schema initialization;
the data-manager database role must be allowed to install it. The index qualifies
both generation and geometry, including when multiple country versions are
retained. Existing single-geometry indexing is replaced on initialization.
EWKB keeps the internal generation store out of Martin's
automatic spatial-table discovery: an unversioned table endpoint would otherwise
bypass the API's generation and read budgets. Tile queries decode the indexed
geometry before MVT encoding. Existing Martin sources and configuration are
unchanged.

Generation URLs never change their bytes when sources refresh. At most eight
snapshots are retained. Unreferenced generations can be removed only after their
cache lease expires. The lease renews when leaving active discovery or rolling
back, covering seven days plus the one-minute discovery refresh interval from
that transition, regardless of the original publication date. Active and previous
are preserved. Publication renews the outgoing lease from the current database
clock at activation, so a long country build does not shorten its protection.
If all slots still have cache leases,
publication refuses another build. Disable changes discovery within the client's
one-minute refresh interval; it does not revoke previously downloaded tiles.
Clients keep a fresh last-good manifest on temporary discovery failure and remove
an explicitly disabled or over-age publication. No published region means ordinary
basemap browsing.

Accepted OSM↔GERS links determine identity: `osm:<type>/<id>` remains primary and
GERS remains an alias, including when Overture display fields are excluded and
the valid OSM place remains. Overture-only places use `overture:<GERS>`. Published
ambient bigint IDs remain strings in generation SQL, tiles, search aliases and
details. OSM field values win;
Overture fills missing names and unmatched coverage. A known excluded OSM match
cannot be resurrected by its Overture counterpart. Linked OSM counterparts are
read and evaluated even across the bbox boundary, within the same OSM input cap.
Authoritative OSM locations outside the chosen region omit the pair; they do not
become an Overture gap with lost closure or tenant policy. Tiles carry canonical ID, GERS,
localized names, category, rank, minimum zoom, tenant flag and source combination.
For supported older alias-focused regional/Germany indexes, an available linked
row in the Overture OSM snapshot supplies authoritative policy and location when
the search-index row is absent. Private/disused records remain excluded and
upper-floor tenants retain zoom-18 deferral. Rebuild the index for complete
format 2 named-POI coverage.

The client suppresses ambient features already owned by a category/selection ID.
An owned-basemap label can acquire the canonical identity only through an explicit
OSM ID or, only when no explicit identity is supplied, a unique compatible-category/name
match within ten metres. Worship matching uses its destination class, not the religion subclass. An explicit different OSM identity is never replaced
by proximity. Ambiguous
branches and non-ground tenants are not matched by proximity. Mappings belong to
the map instance and are cleared on style replacement and overlay teardown. The
existing place-card conversion/resolver handles both tile and basemap clicks.
When the optional Overture search provider has no registered resolver, the place
API resolves a matching GERS alias from source-fresh retained ambient snapshots,
preferring the active generation and then the newest retained match,
retaining canonical OSM/GERS identity and supplied names. Enabled-provider GERS
details also apply accepted same-release links and retain the OSM primary plus
GERS alias while supplying richer Overture metadata. Its existing detail
cache key includes that generation. Discovery disable or replacement does not revoke snapshot
identities in still-retained, source-fresh generations already exposed in cached
tiles. Removed or source-stale snapshots cannot resolve through this fallback. The richer live Overture metadata
continues to use the enabled provider; unpublished disabled-provider deep links
retain their existing coordinate fallback.

## Policy and read budgets

- OSM: named valid points, no explicit closed/disused/abandoned/demolished/removed
  or private-access records. Non-ground level/floor records start at zoom 18.
- Overture: named valid points, known `open` status and finite confidence ≥0.5.
  Missing values are omitted. Unsupported contributor datasets block publication.
- Labels: supplied German/English names, otherwise the source name; the shared
  style localization pass accepts colon and underscore language fields; at most 120
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

## Cartographic integration

Ambient destinations borrow their category badges, label colors, fonts, sizes and
halos from the active basemap's POI layers. The owned light/dark styles therefore
share the same sprite assets and visual vocabulary; hosted styles keep their own
assets. Only the rendering adapter translates publication categories (for example
`doctor` to `doctors`, `office/association` to `office`, or a supplied Overture
`dental_clinic` to `dentist`). It does not change canonical
IDs, ranking, source coverage or the published tile schema.

Ordinary destinations use one label position below the badge. Corroborated
landmarks use the basemap's bold landmark typography, a compact six-em wrap width
and six collision-safe candidate positions. All destinations use the ordinary
native badge size; an enlarged landmark badge can otherwise collide while the
normal POI badge fits. Icon and label must fit together. Unknown destination
categories use the owned basemap's neutral marker badge from the shared POI
registry; `multi` still means a sports pitch. Hosted styles retain their own
fallback. Category mappings
are visual only and do not change published categories or ranking. Neither icons
nor text force overlap or ignore placement. Existing
basemap road/transit labels retain priority, and selection/category/basemap
identity suppression applies independently to both symbol partitions. Basemap
style reloads refresh the borrowed cartography and suppression filters.

## Serving comparison and decision

Both alternatives use the same canonical policy and MVT content:

| Choice                        | Publication/operations                                                                | Reads                                            | Tradeoff                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Regional PMTiles              | Precompute covered cells, verify archive, stage immutable file and switch discovery   | Static range reads or Martin archive ZXY         | Portable/offline-friendly; requires an archive builder, tile enumeration and file/object lifecycle      |
| Existing Martin + PostGIS MVT | Publish immutable rows and serve a generation-specific SQL function                   | Martin cache in front of indexed PostGIS         | Existing service; direct auto-published tables/functions need explicit generation routing and budgets   |
| Implemented API + PostGIS MVT | Same immutable PostGIS representation with validated generation/XYZ and bounded reads | Existing API cache headers and PostGIS functions | Adds SQL work for uncached reads; keeps failure/concurrency/size guards in the established API boundary |

For the regional and global implementation, the API/PostGIS path avoids adding a second storage
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

An earlier native-browser development check of the initial dot/label renderer at
1280 × 800 used 1,006 synthetic places
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

## Real regional acceptance: October 8–9, 2026

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

The original Rhine run has **OSM-only coverage**; the subsequent combined Neuss
run below verifies actual Overture coverage. For the original run, optional Overture/confidence/conflation and
published-GERS detail resolution are covered by the PostGIS regression fixtures,
not claimed as a live Overture extract. Single-name source features without aliases
or codes can be absent from the existing alias/code-focused search index. The
committed landmark corpus distinguishes source presence from index eligibility;
this change preserves that existing ingestion/geocoder behavior.

Actual Quirinus-Münster (`osm:way/28562993`) and Cologne Cathedral
(`osm:way/4532022`) publish at zoom 14 through corroborated source tags.
Names still compete for available space: eligibility does not guarantee a label
in every camera. Six candidate anchors allow a corroborated landmark name to use nearby
whitespace while retaining collision avoidance and road/transit priority. Ordinary
destinations retain one label position to bound placement work and crowding.
The selected/category/basemap suppression filter is repaired per live layer after
paint-only theme recreation as well as full style replacement. OSM-only publication
credits use the actual OSM source; combined publications retain the supported
Overture contributor notices. The overlay registers these source IDs through
the shared `useSourceAttributions` API and clears its credits when hidden.

The actual extractor-to-index-to-publication run also caught JSONB-array tag
serialization: serialized strings had been stored as JSON strings rather than
objects. The index writer now casts text values once to JSONB objects, and ambient
policy safely reads legacy serialized objects. Private/closed legacy tags therefore
remain enforceable without a global migration.

The [aggregate acceptance evidence](https://github.com/OpenMapX/openmapx/blob/main/docs/docs/developer/ambient-places-acceptance.json) records
source hashes, runtime/settings, measured targets, fixed camera outcomes and
external screenshot checksums. It contains no screenshot binaries or credentials.
Selected real before/after and iOS screenshots are attached directly to PR #436.
The earlier static views, images, tile reads and frame measurements use generation
`59337707-c217-4398-966c-3c21ac8237b1`, containing the same 13,454 places and
checksummed source. Earlier generations and measurements remain explicitly
identified in the artifact. T3 preview handled initial static/frame QA; after
`preview_open` explicitly reported unavailable, isolated foreground system Chrome
completed desktop/phone-CSS frames, the static matrix and desktop/admin images.
Native iOS screenshots and frames use Safari through the T3 device tools.
No headless frame measurements are claimed in that run.
The branch then integrated newer main and Next 16.3.8. Those historical captures
retain their exact source checksums and runtime. The cartographic follow-up below
identifies the subsequently changed renderer separately.

| Regional check                           | Declared limit |   Observed |
| ---------------------------------------- | -------------: | ---------: |
| Publication after indexing               |           60 s |    0.655 s |
| First repository tile read               |       1,000 ms |   32.85 ms |
| Warm sparse/dense p95, 30 reads          |         100 ms |    4.53 ms |
| Eight concurrent reads p95, 40 reads     |         250 ms |   47.61 ms |
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
name lists and basemap POI identities (source, source layer, feature ID, rendered
layer, coordinates and name); decoded tiles and visible ambient label lists
have no duplicate explicit IDs. A native pointer tap opens Quirinus-Münster with
canonical ID `osm:way/28562993`; overlapping category and DOM markers retain
click priority. Selected-label suppression survives both paint-only
theme recreation and full style replacement. English/German labels retain supplied colon or underscore language properties
after the real map localizer runs, then fall back conservatively to the source name. External enrichment is disabled in the QA fixture.
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
| Foreground Chrome, 1280 × 800            |         9.2 ms |        9.2 ms |        0% |
| Same Chrome, phone CSS 430 × 932         |         9.2 ms |        9.2 ms |        0% |
| iPhone 18 Pro simulator Safari, isolated |          33 ms |         33 ms |        0% |

The final isolated run pauses the device preview stream and removes our second
QA WebGL map. Six collision-placement candidates retain the actual Quirinus name
where four/five fail, while bounding work below the original eight-candidate
policy. The preceding same-generation eight-candidate run measured 32/34 ms off/on
and missed the on target; its samples and code hashes remain in the artifact.
Earlier streamed 33/34 ms and shared-load 35/36 ms samples remain diagnostic
evidence. No unrelated host process was stopped.

The unchanged target is pooled p95 ≤33.4 ms and intervals >50 ms ≤5%.
The final six-candidate isolated simulator run meets it; individual on sweeps
still reach 34 ms. This is a qualified local simulator result, not a claim that
every sweep or physical device passes. An earlier forced-`jumpTo`-every-RAF stress
workload missed mobile targets in both states; those raw samples remain external
and are not relabeled as normal app camera behavior. Physical-device thermal/battery
behavior and deployed network/CDN latency remain rollout checks.

## October 9 cartographic correction

The separate teal dots and sideways labels did not match the owned map style.
The correction above borrows the active style's POI badges and typography instead.
It republishes the same cropped source into disposable generation
`d90ce37e-f37a-49ba-8143-97a18674fbd5` (13,454 places, unchanged policy 2), and
renders the before/after styling states against that same generation and camera.
The captures use production Next 16.3.8 and MapLibre 6.10.0. T3's native Electron
preview supplies desktop/light/dark verification; Safari on the iPhone 18 Pro
simulator supplies mobile screenshots and its own frame samples.

The repeated 45 camera pairs at phone CSS dimensions 430 × 932 preserve every
basemap POI identity and road-name list, with zero duplicate ambient IDs. The
zoom-16 Neuss camera retains Quirinus-Münster, including in the native simulator
view. An actual pointer tap on its placed name opens `osm:way/28562993` and hides
its ambient copy. Style replacement refreshes category colors, fonts and halos.
Before/after captures remain PR attachments outside git; their SHA-256, exact
code hashes and all frame samples are qualified separately in
`visualCartographyFollowup` in the aggregate artifact. Earlier dot-renderer
measurements above remain historical evidence.

Five five-second desktop sweeps per state have pooled frame-interval p95 of
10.1/10.1 ms off/on. The initial native simulator run measured 36/34 ms and
missed the unchanged 33.4 ms target in both states. An isolated repeat measured
33/33 ms, with no on-state intervals above 50 ms. Across both runs the pooled
native p95 is 34/34 ms; individual sweeps and the initial off-state slowdown
remain in the artifact. These measurements establish a qualified local repeat,
not a guarantee for physical devices or competing host load.

## Real combined-source acceptance: October 9, 2026

The latest follow-up uses the existing Overture importer and conflation job,
alongside the real OSM extract above, in a disposable database. It publishes a
bounded Neuss subset `[6.64,51.14,6.75,51.25]` of the Düsseldorf source region;
this does not claim coverage of the entire region. The installed Overture Places
release is `2026-09-23.1`, verified through its STAC catalog. Its two overlapping
source assets produce a bounded Parquet containing 15,232 rows / 2,112,192 bytes,
with SHA-256 `708a6e41ac21dbfb8a99923f18d94af5e9af4fb4dd506c0f99ab0d7852ce5eef`.
Contributor names and source asset URLs are recorded in
`combinedSourceCartographyFollowup` in the aggregate evidence.

The existing structured matcher, without embeddings, completes conflation before
publication. It accepts 921 source links across the indexed extract. Within the
publication bounds and policy filters, generation
`1f2bfe9c-c389-465d-8d38-7db8e17f5ba7` contains **10,138 places: 1,412 OSM-only,
8,690 Overture-only and 36 merged OSM/Overture**. No records or links are inserted
as synthetic acceptance witnesses. The regional labeled quality corpus has no
applicable cases inside this subset; its successful gate therefore does not
establish local match precision.

Actual tile reads and both the snapshot fallback and enabled Overture detail
resolver retain Quirinus-Münster's primary `osm:way/28562993` plus GERS alias
`afb26729-88d4-43a4-81e8-1c3cf5492082`. The Overture-only Cafe Bar Kleeberg retains
`overture:6ffbe79a-b1ce-4900-93f6-b64b67d67ed5` through its tile, cafe category
search and details. Pointer taps on both placed badges select those identities;
the selected ambient copy disappears. External enrichment is disabled in this QA
fixture. The real admin component displays the combined generation, release and
eligible source counts.

| Combined Neuss check                       | Declared limit |     Observed |
| ------------------------------------------ | -------------: | -----------: |
| Publication after indexing/conflation      |           60 s |      0.660 s |
| First dense repository tile read           |       1,000 ms |     31.82 ms |
| Warm dense p95, 30 reads                   |         100 ms |     10.58 ms |
| Eight concurrent dense reads p95, 40 reads |         250 ms |     67.57 ms |
| Dense tile features / bytes                |  256 / 131,072 | 256 / 38,529 |
| Explicit IDs duplicated in decoded tiles   |              0 |            0 |

The new light/dark desktop and native iOS screenshots use this combined
publication. Genuine before captures use pre-PR revision
`78e0990764247359d724a58b6aa3884eb2150291`, rather than an intermediate PR state.
Quirinus-Münster now requires its normal native POI badge and label to fit
together. ADAC Center Neuss uses the native office badge in its controlled zoom-18
comparison; at the original zoom-16 camera it can still lose collision placement.
Eligibility is not a promise of visibility at every camera.

Frame evidence and any unsuccessful diagnostic attempts are recorded separately
from the historical OSM-only runs above. The same pooled p95 ≤33.4 ms and
intervals >50 ms ≤5% targets remain binding. These local measurements do not
establish physical-device or deployed network/CDN performance.

After freshly invoking T3's native Electron preview and verifying the current
sprite assets, five sweeps per state measure desktop pooled p95 9.8/9.9 ms off/on,
with no intervals over 50 ms. Earlier preview-connection samples missed the
budget in both states; the artifact retains them as unsuccessful diagnostics.
An earlier Electron repeat loaded stale assets from the local QA-origin cache
and is not used as final acceptance. Release asset cache invalidation already
uses the committed build revision; the dirty QA rebuild reused that revision.

The first combined-source native iOS run, with device streaming active, measures
38/35 ms off/on and misses the p95 target. Pausing that stream and removing the
second QA map produces an isolated five-sweep-per-state repeat of 29/30 ms,
with 0.076%/0.394% of intervals over 50 ms. No builds/tests run concurrently and
no unrelated host process is stopped. Because the native touch runner fails to
accept connections, a temporary trusted QA-route helper starts the same sweeps
after verifying the exact combined generation and current sprite; simulator URL
opening brings Safari to the foreground. Product security policy is unchanged.
Both the unsuccessful run and the passing qualified repeat remain in the artifact.

## Global fixture acceptance: October 10, 2026

The separate [global fixture artifact](./ambient-places-global-acceptance.json)
records a synthetic 10,001-row source distributed across Tokyo, New York, Cape
Town, Sydney and São Paulo. On local PostgreSQL 18/PostGIS 3.6, publication took
0.508 s and one indexed generation used 2,850,816 bytes. With two retained
generations, `EXPLAIN` prunes the other planet partition and selects an index
for generation/spatial reads. A dense Tokyo tile contains 256 features/19,926
bytes; twenty warm reads have p95 about 9.7 ms (individual samples in the artifact).
These are fixture observations, not planet capacity or global latency claims.

Separate real-database regressions cover committed checkpoints/resume, backend
termination, writer/source contention, same-release source changes, count/policy/
disk/output failures, hidden staging tile/GERS reads, leased partition retirement,
rollback, native Japanese/bigint identities, polar exclusion and both dateline
buffers. Component propagation crosses a 10,000-update page boundary, and dense
assignment/neighborhood guards fail closed. A tiny actual pinned DuckDB 1.3.1/
osmium probe verifies resource settings and file-backed Japanese-label extraction.
Full planet preparation, peak source-tool memory/WAL, realistic cold/concurrent
traffic and production CDN/backup recovery still require deployment acceptance.
Earlier Neuss and Germany evidence in this page remains explicitly historical
and regional; it does not prove global source completeness or throughput.
