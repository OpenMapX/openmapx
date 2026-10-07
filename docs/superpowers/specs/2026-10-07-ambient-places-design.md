# Regional ambient places (#399)

## Outcome and scope

Ordinary map browsing shows useful named places from the existing OSM search
index and optional Overture snapshot, without starting a category search.
The initial operator preset is Aachen: `[5.9, 50.65, 6.3, 50.95]`. An operator
may choose one other bounded German region. This is regional publication, not
new ingestion. OpenConditions, adapters, feeds, mobility contracts, planet
imports, direct ATP ingestion and geocoding behavior are outside the change.

Use the attached isolated worktree and a feature PR. Preserve all other
checkouts. Implement and self-review without approval checkpoints; finish with
verification, current documentation and before/after PR screenshots. Do not
merge or deploy. Keep screenshot files outside the repository.

## Storage and publication

Publish an immutable generation in dedicated `ambient_places` PostGIS tables.
Store projected points as EWKB bytes with a functional spatial index so Martin's
automatic table discovery cannot expose an unversioned, unbounded alternate source.
A repeatable-read transaction reads the existing OSM index, Overture records
and accepted OSM/GERS links together. It builds a separate candidate, validates
it, then atomically changes the singleton active pointer and previous pointer.
A failed build cannot replace the last good generation. A transaction-scoped
advisory lock rejects concurrent publishers and pointer mutations. Rollback
swaps active and previous; disable stops public discovery without deleting data.

The region must be a finite, ordered bbox inside Germany's bounding rectangle
`[5.8,47.2,15.1,55.1]`, no more than 0.5 degrees wide or high. Input queries are
spatially indexed, limited to 100,001 rows each; more than 100,000 from either
source rejects publication. Candidate output is limited to 100,000 places,
written in batches of 500. No empty generation may replace a working layer.
Keep at most eight committed generations. Prune only unreferenced generations
after their seven-day plus one-minute retirement lease expires; renew the lease
when leaving active discovery or rolling back, independently of publication age.
If retention prevents freeing space, refuse the build.
Transactions have a 120-second statement timeout. Operator rebuilds run as
one asynchronous in-process job, with database locking as the cross-process
authority. A restart cannot leave a permanent job lock.

Require a ready OSM epoch with a publication timestamp. If Overture exists,
require completed conflation for its current release. Missing Overture is an
explicit OSM-only coverage state, not an error. Reject source publications
older than 90 days; an active generation older than 90 days is not discovered.
Manifest reports source region, epoch/release, publication time, counts,
missing-source state, policy version and generation. These are snapshot ages,
not assertions about when the real-world place was last verified. Never expose
local source paths, fingerprints containing paths, or operator error details in
the public manifest.

## Place policy and identity

Use only existing accepted links, never a new proximity conflation during
publication. Linked pairs use `osm:<type>/<id>` and carry GERS; OSM wins location,
name and category while Overture fills missing localized names. Unlinked
Overture places use `overture:<GERS>`. Preserve IDs as strings, including OSM
bigints. Overture search results with an accepted link use the same OSM primary
ID even when the OSM record was not returned by that search; retain GERS for
enrichment. Tile selection calls the existing `categoryPlaceToPlace` path so
search, place cards and saved places share the same identity contract.

Exclude unnamed/invalid coordinates, closed/disused/abandoned OSM objects,
private access, permanently or temporarily closed Overture objects, unknown
operating status, and Overture confidence below 0.5 or missing. An open OSM
record remains usable if linked Overture is excluded. Non-ground floor/level
OSM tenants require zoom 18 and must not be matched to a basemap label by
proximity. Unknown floor is displayed conservatively and makes no entrance or
ground-level claim. No guessed brand replacement or transliteration. Carry
trimmed original name plus German and English names where actually supplied;
fall back from UI language to original name. Cap each label at 120 characters.

Rank deterministically using OSM importance and category utility, never claimed
popularity. Health, transport and civic landmarks appear at zoom 13; everyday
shops and services at 15; other named places at 16; tenants at 18. Tie-break by
canonical ID. Tile properties include canonical ID, GERS, names, category,
rank, minimum zoom, tenant flag and source flags. Generation provenance belongs
to the manifest and source metadata; place cards use existing resolvers.

## Serving decision and budgets

Compare regional PMTiles against the existing Martin/PostGIS setup. Select
PostGIS MVT for this first online release: existing data and spatial indexes,
no new ingestion/archive tools, atomic generation pointer, bounded requests,
and simple rollback. Use the same PostGIS MVT functions Martin uses behind a
small API route, because generation validation, byte/concurrency bounds and
public/private metadata separation need an explicit contract. Martin remains
available for existing layers. PMTiles is attractive for immutable CDN/offline
archives but requires archive generation, coverage planning and update downloads;
it is deferred to #403 rather than silently promised here.

Public routes: `/api/ambient-places/manifest` and
`/api/ambient-places/tiles/:generation/:z/:x/:y.mvt`. Manifest is no-store. Tile
URLs contain immutable UUID generations and use seven-day immutable cache.
Validate UUID and integer XYZ (zoom 13–18). A tile contains at most 256 ranked
features and 128 KiB, with a 2-second SQL timeout and at most eight concurrent
requests per API process. Over-budget requests fail without cacheable content;
missing/disabled/no-data manifests allow normal basemap browsing to continue.
Old generation URLs survive publication and rollback during the cache lease.
No query-time per-place enrichment, source calls, or unbounded regional scans.
Measure real PostGIS dense/sparse tiles, repeated tile requests and build time;
record fixture size and hardware/runtime limits honestly in the PR/docs.

## Map behavior

A built-in map overlay is on by default and independently switchable through
the existing layer selector. It requests only the advertised bounds at zoom
13–18. Refresh the manifest every 60 seconds, abort obsolete requests, retain a
last-known generation only while its age is acceptable, and release sources,
layers and event handlers on disable/unmount. Rebuild on style changes through
`useMapLayerGroup`. Use small point symbols and collision-controlled text under
basemap symbols so road/transit names retain priority. Use localized labels,
short halo text and deterministic symbol-sort-key. No DOM marker per place.

Suppress ambient features already shown by category results or selected place,
using canonical IDs and GERS. For owned basemap labels, match explicit OSM refs
first; otherwise allow only one unique, same-name, compatible-category point
within 8 metres, never known non-ground tenants. Hide the ambient copy and carry
its canonical place into the basemap tap/hover path. Ambiguous names/branches
stay separate. Scope mappings to each Map instance; remove them on teardown.
Do not change other overlays' filters or selection behavior.

The existing source-attribution registry credits OSM and all supported Overture
contributors. A compact overlay legend reports region, snapshot time and
OSM-only versus combined coverage; absence/error is stated without blocking the
map. Source license metadata remains sourced from existing manifests.

## Administration and documentation

Add an ambient-place maintenance card under Admin → Data workflows. Show active
and previous generations, source versions/age, counts, missing-source state,
last build result, and enablement. Provide bounded region inputs, publish,
enable/disable and rollback actions. Use existing admin authentication and
validated data-manager proxy; audit mutations. Failed builds retain last good
state and are visible to the operator. Do not make publication reachable from
public routes.

Update existing Overture Places and Map Layers pages with prerequisites,
regional limits, source policy, cache/rollback operation and attribution. Add a
focused performance/architecture record including the PMTiles comparison and
actual measurements. Update API surface and integration inventory as required.

## Verification

Unit tests cover label/closure/ranking policy, string IDs, bounds and conservative
dedup. Real disposable PostGIS tests prove spatial selection, accepted-link
identity, MVT decoding/content, deterministic feature budgets, immutable old
tiles, atomic failure, retention, rollback and concurrency. API injection tests
prove public validation/cache/error budgets and admin separation. Component and
map tests cover source switching, style reload, stale fetches, no-data/disabled,
selection and handlers. Live browser QA exercises dense and sparse fixtures,
locale, tile tap and details, pan/zoom, overlay toggle, basemap style change and
admin workflow. Screenshots are explicitly identified as fixture-backed if no
regional source data is locally available. Run repository lint, types, unit
suite and relevant builds; report environmental verification limits precisely.
