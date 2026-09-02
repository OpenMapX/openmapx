---
"@openmapx/mobility-core": minor
"@openmapx/core": minor
---

Add sampled, exportable transit isochrone polygons. Travel times are sampled
from self-hosted MOTIS across a bounded lattice and contoured with marching
squares, producing downloadable RFC 7946 GeoJSON that carries its own sampling
resolution, accuracy statement, and attribution. The estimated WebGL field
remains the interactive default; polygons are opt-in per deployment.
