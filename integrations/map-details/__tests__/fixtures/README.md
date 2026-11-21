# Map details tile fixtures

Real vector tiles for the derivation tests, gzipped (`gzip -9n`).

Contains information from OpenStreetMap, which is made available under the
Open Database License (ODbL) 1.0. © OpenStreetMap contributors,
<https://www.openstreetmap.org/copyright>.

## Street detail tiles (z16, XYZ)

Built from the Geofabrik Berlin extract of 2026-11-21 (`berlin-latest.osm.pbf`,
last modified 02:40 UTC) with the pinned Planetiler 0.10.2 image and the
`STREET_DETAIL_SCHEMA` of `packages/cli/src/lib/street-detail-schema.ts`.

| File                                   | Place                                                |
| -------------------------------------- | ---------------------------------------------------- |
| `street-16-35209-21492-alexanderplatz` | Alexanderplatz: junctions, trams, trees, lamps       |
| `street-16-35198-21496-turn-lanes`     | Potsdamer Platz area: roads with mapped `turn:lanes` |
| `street-16-35215-21491-tram`           | Greifswalder Straße area: street-running trams       |
| `street-16-35182-21501-a100`           | A100 near Messe: motorway with `lanes=3`             |
| `street-16-35214-21499-pitch-west`     | Neukölln sports grounds, west tile of a pitch pair   |
| `street-16-35215-21499-pitch-east`     | Neukölln sports grounds, east tile of a pitch pair   |

## Basemap tiles (z14, XYZ)

OpenMapTiles schema 3.16 from openmapx.com's public tiles, fetched 2026-11-21:
`basemap-14-8795-5376` (Grunewald) and `basemap-14-8795-5377` (its southern
neighbour), which share a forest edge.
