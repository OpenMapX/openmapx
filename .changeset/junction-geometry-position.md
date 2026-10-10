---
"@openmapx/core": patch
---

Anchor junction positions and approach traces to maneuver coordinates on the route geometry, preventing routing-distance drift from skipping junctions and their photos on longer trips.

Preserve turn-only lane approaches and distinguish the permitted branch lanes. Register photo overlays against visible lane markings, project each permitted lane separately using the fitted camera pose, and omit overlays when the photographed layout is uncertain.
