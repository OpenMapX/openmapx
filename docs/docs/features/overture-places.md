---
title: Overture Places
description: Regional Overture Places snapshots for additional POIs, enrichment, stable identity, and source attribution.
sidebar_position: 3
---

# Overture Places

OpenMapX can use [Overture Maps Places](https://docs.overturemaps.org/guides/places/)
as a second, locally hosted POI source alongside OpenStreetMap. It does more
than enrich OSM records: a place present only in Overture is returned as its own
search result and opens as a complete place card with a stable GERS identifier.

The integration is optional. Without it, category search continues to use OSM
through Overpass. Activating it has two layers: enable the data lifecycle with
`OVERTURE_ENABLED=true`, then enable `poi-overture` for search and
`knowledge-overture` for place-card enrichment in **Admin → Integrations**.
These runtime integrations are independent, so an operator may enable either or
both. With both enabled, OpenMapX queries both sources, matches records that
describe the same real-world place, and keeps unmatched Overture records as
coverage gap-fill.

## Imported fields

The regional snapshot stores GERS identity, geometry, Overture's
`basic_category` and `taxonomy` hierarchy, multilingual names, addresses,
contacts, brands, confidence, operating status, release, and property-level
source records. Opening hours are not an Overture Places field and are never
inferred from `operating_status`; OSM opening hours remain authoritative.

Category matching follows Overture's published hierarchy. OpenMapX maintains
only a small bridge between its broad UI categories and broad Overture concepts;
it does not copy or freeze Overture's thousands of leaf categories. New leaf
categories work automatically when their upstream hierarchy reaches a supported
broad concept.

## Identity, fusion, and quality

An Overture-only result uses `overture:<GERS ID>` as its primary identity. A
matched OSM result keeps its `osm:` identity and also carries the GERS ID.
Precomputed OSM↔GERS links are preferred; remaining candidates are matched
conservatively using distance, normalized name, category, address, phone,
website, and Wikidata evidence. OSM wins overlapping fields and Overture fills
gaps.

Candidates are selected nearest the map center, then by confidence and field
completeness. The combined result is deterministically reranked, conservative
same-business duplicates are removed, and the response is capped at 50 places.

## Nearby places during normal browsing

The built-in `overlay-ambient-places` integration can show named places without
starting a category search. An administrator first builds the existing
OSM search index; an Overture snapshot is optional, but a populated Overture
source must have completed its link rebuild. In **Admin → Services → Data
workflows → Nearby places**, choose **Germany** or **Custom region**. Germany
requires prepared `europe/germany` OSM and optional Overture snapshots; regional
sources are rejected for a country publication. The national publisher processes
2,000 source rows per keyset batch, checks PostGIS disk headroom and activates one
validated country generation. The active map remains available during the build.
The custom form
covers Aachen (`5.9,50.65,6.3,50.95`). The box may span at most 0.5 degrees in each
direction, with at most 100,000 input rows per source and 100,000 final places.
Linked OSM counterparts across the boundary count toward the OSM input cap and
retain their closure/tenant policy and authoritative location. A pair whose OSM
location is outside the box is omitted. Coverage follows the installed snapshot
inside Germany's rollout envelope, with no political-border clipping or planet
import. The OSM search index's existing alias/code/acronym selection still limits
which named OSM objects are available to this layer.

Named essential destinations start at zoom 13, everyday businesses at 15 and
other places at 16. Non-ground OSM tenants wait until 18. Explicitly closed,
disused, demolished or private OSM records are omitted. Overture records require
known `open` status and confidence of at least 0.5. Missing confidence/status
is omitted rather than guessed. Labels use a supplied German/English name and
fall back to the source name; names are capped at 120 Unicode characters. No
hours, ratings or popularity are inferred. Missing OSM fields may be filled by
an accepted Overture match; unmatched Overture records fill coverage gaps.
Accepted OSM↔GERS links retain the OSM primary ID across tiles, search and place
cards, even when the OSM record is outside the ambient candidate set.

The admin card reports generation, region, counts, source epoch/release,
publication time and build errors. Country progress distinguishes processed
source rows and staged places from the activated snapshot. Country builds hold
source-operation locks until publication finishes, so schedule them after source
preparation and budget retained versions, temporary writes and transaction logs.
A snapshot date describes the local data
publication, not a recent verification of every business. Source/publication
age above 90 days disables discovery. Coverage is partial: filters, missing
source data, ranking caps and label collisions can all omit places.

Publishing stages a complete immutable generation and activates it in one
transaction. A failed or interrupted build retains the active generation.
**Disable** removes it from discovery; **Roll back** switches to the predecessor.
Neither requires another rebuild. A competing mutation receives `409` until
publication finishes. Clients refresh discovery
every minute and retain a fresh last-known generation during a temporary API
failure. Already cached tile URLs remain valid for their seven-day cache lease;
disable is therefore a discovery change, not immediate revocation of cached data.
At most eight generations are retained. Cache protection renews when an active
generation is replaced or rolled back, even if the original publication is old;
publication refuses to evict an unexpired generation just to make room.

The online path uses bounded PostGIS MVT reads behind the existing API. Regional
PMTiles remain a possible offline/export delivery option, not an offline feature
of this overlay. [Publication and serving decisions](../developer/ambient-places-publication.md)
explain the comparison, limits, tests and rollback model.

## Releases and regional refreshes

OpenMapX discovers the current release from Overture's official STAC catalog
and skips a release already installed. The pull follows the release → Places →
place hierarchy and uses the exact immutable Parquet assets declared by STAC;
it does not construct a wildcard storage path. STAC item extents first remove
global partitions that cannot intersect the configured Geofabrik region, then
DuckDB applies the regional bounding box and projects only the fields OpenMapX
uses.

Before publishing the local snapshot, the job checks the nested ingest schema,
row and ID integrity, Point geometry, theme/type identity, and contributor
coverage. It writes a release contract beside the Parquet file containing the
resolved STAC items, source row counts, region bounds, projected columns,
observed rows, contributors, and file size. Ingest requires that contract and
checks its row and contributor counts again in the staging schema before the
atomic swap. A standalone or stale Parquet file therefore cannot be labeled as
a different release. Optional OSM↔GERS links are rebuilt when the matching
regional OSM PBF exists. A failed pull or ingest cannot partially update the
live places table; the regional database does not use global changelog data.

Places publication and link rebuilding are independent lifecycles. Each Places
release starts with a durable `pending` link state. The rebuild records
`extract`, `score`, `assign`, `publish`, and `complete` phases, keyset and
component cursors, source fingerprint, heartbeats, attempt counts, separate
emitted-geometry and unique-POI counts, and per-phase durations in PostGIS. A
failed or interrupted attempt leaves the Places release active. Recovery is
attempted once at data-manager startup and every 15 minutes thereafter. A retry resumes its saved phase: completed OSM
extraction is not repeated, scoring continues after its last committed keyset
cursor, and assignment continues after its last completed graph component. If
the local PBF fingerprint changes—even after a previously completed run—the
state safely restarts from extraction. Across Overture releases, an unchanged
OSM table and its fingerprint are moved into the new release in constant time,
so only Overture-dependent scoring and assignment repeat.

The rebuild is designed for country-scale inputs. OSM GeoJSON sequences are
parsed directly into fixed-size Postgres batches and published with an atomic
table swap. Matching reads OSM with keyset pagination, fetches only indexed
ring-1 H3 cells from Overture, and materializes accepted edges in a durable
working table. A lightweight endpoint pass labels the graph's disconnected
components. Full scored rows are then read in bounded component groups, while
each component independently enters the exact cardinality-first assignment
solver. This preserves the region-wide optimum without loading or sorting the
country-wide scored graph as one object. The completely assigned next-link
snapshot is durable and replaces the live link table in one transaction, so a
failed attempt can never expose a partial link set. A PostgreSQL advisory lock
serializes schema swaps, OSM snapshot publication, and link rebuilding across
data-manager processes. Temporary filtered PBFs are removed after extraction.
Capacity checks measure the host `/data` filesystem before a pull and the
PostgreSQL container's actual data filesystem before staging or conflation.
Each reserves estimated working space plus a safety margin and fails with an
actionable byte estimate instead of filling either filesystem.

The staged Places snapshot is checked against release-pinned, human-reviewed
category cases before activation. After link assignment, the final fused
OSM-authoritative plus Overture-augmenting response is checked again before
publication. The corpus covers cafés, restaurants, supermarkets, pharmacies,
hotels, and fuel across urban, rural, German, and cross-border locations,
including known upstream category mistakes and duplicates.

After a complete ingest, fused quality check, and link publication, OpenMapX
retains the active local release snapshot and one predecessor by default. Older
release directories are pruned whether publication completed in the original
sync or an independent retry; incomplete refreshes never trigger pruning.
Durable finalization markers prevent completed retries from repeatedly
truncating work tables or rescanning release directories.

Run the complete workflow manually with:

```sh
pnpm openmapx data overture-sync europe/germany/berlin
```

Resume the installed release's saved rebuild phase with:

```sh
pnpm openmapx data overture-conflate europe/germany/berlin
```

Discard saved progress and deliberately restart from OSM extraction with:

```sh
pnpm openmapx data overture-conflate europe/germany/berlin --restart
```

Inspect the installed release, phase, cursors, counts, timings, heartbeat age,
and last error with:

```sh
pnpm openmapx data overture-status
```

## Provenance, licensing, and privacy

Every Overture result retains its upstream `sources` entries: dataset, property
path, record ID, update time, reported license, and Overture release. The result
list and place panel show attribution only for sources that actually contributed
returned records.

Places is multi-license. Most current contributors use
CDLA-Permissive-2.0, AllThePlaces uses CC0-1.0, and Foursquare records use
Apache-2.0. OpenMapX preserves Foursquare's copyright notice and records its
transformation date. See [Overture attribution and licensing](https://docs.overturemaps.org/attribution/)
for the authoritative current list.

Searches run against local PostGIS. User viewports and place details are not
sent to Overture or its contributors at request time.

## Global source preparation

`planet` is supported alongside Geofabrik extract paths. Overture selects every Places asset from one verified STAC release, with at most eight concurrent catalog requests; it does not fetch a Geofabrik polygon for the world. OSM uses the existing planet PBF download. Prepare matching `planet` OSM and Overture snapshots before publishing global ambient places.

DuckDB defaults to 2 GiB buffer-manager memory, four threads and 32 GiB spill allowance. Set `OVERTURE_DUCKDB_MEMORY_MB`, `OVERTURE_DUCKDB_THREADS` and `OVERTURE_DUCKDB_TEMP_MB` to positive integer limits for the preparation host. Memory outside DuckDB's buffer manager still counts toward container RSS; reserve RAM and scratch storage accordingly. First planet pull admission uses selected STAC row counts at 512 bytes per row as a working allowance, not a measured final dataset size.

Planet osmium exports use `dense_file_array` for node locations. `OSMIUM_PLANET_INDEX_ESTIMATE_BYTES` defaults to 128 GiB and admission requires that allowance plus 5 GiB free on the extraction volume. The index is removed after completion/failure. Area assembly still needs substantial RAM, and filtered PBFs need additional disk; use a properly sized preparation host.
