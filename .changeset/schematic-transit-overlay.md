---
"@openmapx/integration-overlay-schematic-transit": minor
---

Add a schematic transit map overlay. LOOM's OpenStreetMap-derived network-plan
vector tiles (tram, metro/light rail, commuter rail, long-distance rail; geographic,
octilinear, and orthoradial layouts) render as a toggleable map layer. Tiles are
proxied through the API because the upstream service sends no CORS headers; empty
upstream tiles (HTTP 404) become cacheable empty responses. Keyless and enabled by
default; operators can disable the integration or point it at a self-hosted LOOM.
