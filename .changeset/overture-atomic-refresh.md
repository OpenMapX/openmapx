---
"@openmapx/core": minor
"@openmapx/cli": minor
"@openmapx/data-manager": minor
---

Replace the unsafe speculative Overture changelog updater with a release-pinned regional refresh
that pulls one snapshot, atomically swaps the staged places schema, and rebuilds optional OSM links.
Add one API/client/CLI sync operation for the complete workflow.
