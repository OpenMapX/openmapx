---
"@openmapx/core": major
---

Remove `buildIntegrationAttribution`, `buildSourceAttribution`, and `combineAttributions`. Capture exact contributor receipts during acquisition, project only displayed records or fields, and render them with the shared runtime attribution and presentation builders. `pickIntegrationForSources` remains available for translation metadata ownership; it does not establish attribution.

Add the shared `panoramaxAuthor` helper for producer metadata and preserve Commons creator links when a separate linked author is absent. Reviews and review aggregates can retain their acquisition-time contributor receipts.
