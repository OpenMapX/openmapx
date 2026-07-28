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
through Overpass. With it enabled, OpenMapX queries both sources, matches records
that describe the same real-world place, and keeps unmatched Overture records as
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
release starts with a durable `pending` link state. Extraction and matching move
that state through `running`, `completed`, `failed`, or `waiting_for_osm`, with
attempt counts and row counts retained in PostGIS. A failed or interrupted link
attempt leaves the Places release active and is retried every six hours by
default. The retry uses the already installed release and local PBF; it does not
repeat STAC discovery, download, quality validation, or the Places schema swap.

The rebuild is designed for country-scale inputs. OSM GeoJSON sequences are
parsed directly into fixed-size Postgres batches and published with an atomic
table swap. Matching reads OSM with keyset pagination, fetches only indexed
ring-1 H3 cells from Overture, and materializes accepted edges in an unlogged
working table. Isolated one-to-one edges are selected in SQL; only contested
graph components enter the exact cardinality-first assignment solver. The live
link table is replaced in one transaction after the complete assignment is
ready, so a failed attempt can never expose a partial link set. A newly imported
release remains usable without precomputed links until its first rebuild
completes. A PostgreSQL advisory lock serializes schema swaps, OSM snapshot
publication, and link rebuilding across data-manager processes.

Run the complete workflow manually with:

```sh
pnpm openmapx data overture-sync europe/germany/berlin
```

Retry only extraction and link rebuilding for the installed release with:

```sh
pnpm openmapx data overture-conflate europe/germany/berlin
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
