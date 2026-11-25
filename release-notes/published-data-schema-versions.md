---
impacts: [breaking]
---

## What changes

The OSM search index, the notable-places index and the Overture places record
the layout version of the builder that wrote them, in a new required
`schema_version` column of `osm_search.index_state`,
`notable_places.index_state` and `overture_places.conflation_state`. Search,
place-detail and ambient-places readers ignore a snapshot of another version,
and their health checks report it as down. At startup data-manager rebuilds
such an OSM search or notable-places index and re-imports such Overture places;
the search-index status reports it as stale until then. The planet
ambient-places build requires the current versions instead of the former
`ambient_source_version` column, which is gone.

## Who is affected

Operator SQL or tooling that writes these state rows, or reads
`ambient_source_version`.

## Required action

None for installations: their builders write the column, and nothing installed
predates it. Custom tooling that inserts these rows must set `schema_version`.
