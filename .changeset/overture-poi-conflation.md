---
"@openmapx/core": minor
---

Add the OSM↔Overture POI conflation toolkit used by the Overture Places integration. Exposes the bipartite `conflate` matcher (`ConflationPoint`/`ConflationThresholds`/`ConflationResult`/`DEFAULT_CONFLATION_THRESHOLDS`), query-time `fusePoiResults`, the Overture category mappings (`overtureCategoryToOpenMapX`, `openMapXCategoryToOverture`, `OVERTURE_COMMERCIAL_CATEGORIES`, `openmapxCategoryToOvertureLeaves`), and the name-independent matching utilities in `geo-server` (`nameSimilarity`, `normalizeName`, `normalizeStreet`, `osmAddressKey`, `overtureAddressKey`, `normalizePhone`, `parsePhones`, `websiteDomain`). Matching corroborates on address keys, wikidata, and phone/website signals beyond fuzzy name similarity.
