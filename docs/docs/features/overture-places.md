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
and skips a release already installed. A newer release is filtered to the
configured Geofabrik region, loaded into a staging schema, and atomically
swapped into service. Optional OSM↔GERS links are rebuilt when the matching
regional OSM PBF exists. A failed pull or ingest cannot partially update the
live places table; the regional database does not use global changelog data.

Run the complete workflow manually with:

```sh
pnpm openmapx data overture-sync europe/germany/berlin
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
