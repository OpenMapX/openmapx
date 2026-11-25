---
title: Self-hosting map tiles
description: Serve OpenMapTiles vector data and glyphs while keeping the OpenMapX style in the web app.
sidebar_position: 5
---

# Self-hosting map tiles

The default OpenMapX light/dark styles, sprites, and layers ship with the web
app. Choose where they obtain OpenMapTiles-compatible vectors and glyphs. A
separate optional MapTiler full-style mode is described below.

Complete [Getting started](../install/getting-started.md) first. Local tile
preparation needs a healthy data-manager, Docker, and room for the source PBF,
Planetiler workspace, active archive, and staged replacement.

Enabled TileServer GL is selected automatically; explicit `NEXT_PUBLIC_TILES_URL`
also always takes priority. Without local tiles, `BASEMAP_PROVIDER=auto` uses
MapTiler when its effective server-side key is configured, otherwise OpenFreeMap.
Choose `auto`, `openfreemap`, or `maptiler` in **Admin → Settings → Map → Hosted
Vector Basemap**, or set `BASEMAP_PROVIDER` to override the admin value. Reload
the page after an admin change. An explicit MapTiler choice without a key reports
missing configuration; it does not silently switch providers. Invalid provider
environment values are ignored and leave the admin setting editable. Saving a
provider preserves the existing redacted MapTiler key; replace or clear that
field explicitly to change the credential.

OpenFreeMap supplies OpenMapTiles-compatible vectors from its stable `/planet`
TileJSON and keyless Noto glyphs. The OpenMapX light/dark styles and sprites stay
unchanged. Its tiles/glyphs are requested directly by the browser; see the
[provider's privacy policy](https://openfreemap.org/privacy/). MapTiler assets use
the existing backend proxy and keep the key server-side. Neither selection changes
geocoding, satellite imagery or other provider-specific key requirements.

An enabled local server is never bypassed merely because a hosted preference is
set or a local request fails. Configure an explicit glyph base for external local
tiles; without one, glyphs use OpenFreeMap so labels do not require a MapTiler key.
The built-in TileServer GL supplies its own glyphs automatically. Its discovered
`/tiles` paths use the web origin, independently of `NEXT_PUBLIC_API_URL`.
For another tile-server origin (including direct local development on port 8080),
set explicit tile and glyph URLs. It does not
require a second catalog of server-side styles.

Martin is separate: it generates optional overlay tiles from PostGIS and does
not provide the base map.

## TileServer GL inputs

The `tileserver` service consumes only prepared map data:

| Input          | Mounted at      | Produced by                          |
| -------------- | --------------- | ------------------------------------ |
| `tile-mbtiles` | `/data/mbtiles` | `openmapx services build tileserver` |
| `tile-fonts`   | `/data/fonts`   | `openmapx data download fonts`       |

Its checked-in configuration deliberately has no TileServer style catalog. The
web app serves `/styles/openmapx-streets.json`, `/styles/openmapx-dark.json`, and
their shared sprite sheet itself.

### 1. Download glyphs

```bash
pnpm openmapx data download fonts
```

This installs the OpenMapTiles glyph PBF tree atomically at
`data/tile-fonts/`. Set `OPENMAPTILES_FONTS_URL` to use a pinned or internally
mirrored font archive. The download is needed only when TileServer GL or offline
package generation uses the self-hosted OpenMapX dataset.

### 2. Build vector tiles

Download an OSM extract and build the OpenMapTiles-schema MBTiles archive:

```bash
pnpm openmapx data download osm europe/germany
pnpm openmapx services build tileserver --region europe/germany
```

Planetiler writes `data/tile-mbtiles/tiles.mbtiles` and, in a second run from
the same extract, `data/tile-mbtiles/street_detail.mbtiles` (see
[Street detail](#street-detail)). It builds into `data/tile-mbtiles.next/` and
only replaces the archives once both runs succeed, so a failed build keeps the
old tiles. Its JVM heap defaults to half the PBF
size (at least 2 GB; `-Xmx30g` for the planet), and its downloaded sources and
temp files live in `data/planetiler/`, where later builds reuse the sources.
Set `PLANETILER_JAVA_TOOL_OPTIONS` or `PLANETILER_WORK_DIR` in `.env` to change
either. To build on a bigger machine and serve from this one, see
[Building on another host](../install/preparing-data.md#building-on-another-host).

Stop TileServer GL before replacing a running archive:

```bash
pnpm openmapx services stop tileserver
pnpm openmapx services build tileserver --region europe/germany
```

### 3. Enable and link the service

```bash
pnpm openmapx services enable tileserver
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start tileserver
```

`data link` hardlinks the two producer trees into the read-only consumer paths.
With the default local binding, verify the TileJSON, a tile, and a glyph:

```bash
curl -sf http://localhost:8080/data/openmapx.json
curl -sf http://localhost:8080/data/street_detail.json
curl -sf -o /dev/null http://localhost:8080/data/openmapx/0/0/0.pbf
curl -sf -o /dev/null 'http://localhost:8080/fonts/Noto%20Sans%20Regular/0-255.pbf'
```

### 4. Configure the web app

For the built-in TileServer GL, automatic discovery supplies these URLs. Set
explicit values only for a different origin or a deliberate override:

```dotenv
# infra/docker/.env
NEXT_PUBLIC_STYLE_PROVIDER=openmapx
NEXT_PUBLIC_TILES_URL=https://maps.example.com/tiles/data/openmapx.json
NEXT_PUBLIC_MAP_STYLE_URL=https://maps.example.com/tiles
```

`NEXT_PUBLIC_TILES_URL` replaces only the bundled style's `openmaptiles` vector
source. `NEXT_PUBLIC_MAP_STYLE_URL` supplies `/fonts`; despite its historical
name, it is not a style JSON endpoint. The sprites remain same-origin web-app
assets. Offline package preparation, polling, archives, and glyph downloads use
`NEXT_PUBLIC_API_URL` as well; this matters in local development where the web
app and API normally use different origins. Apply changed container values with `pnpm openmapx services start web`,
then reload the page. An in-place restart does not reload environment values.

`NEXT_PUBLIC_STYLE_PROVIDER=maptiler` selects MapTiler's complete hosted style
through the API only when MapTiler is the resolved vector provider. Self-hosted
and OpenFreeMap vectors always use the owned styles. Complete hosted styles do
not use the local OpenMapX offline-package pipeline.

## Street detail

The 3D view draws real-width roads with lanes, crossings, rails, pitch markings,
street trees, lamps, signals and benches from a small supplementary tileset,
`street_detail.mbtiles` (see
[Map layers](../features/map-layers.md#forests-street-objects-and-street-paint)).
The tile build makes it at zoom 16 from your OpenStreetMap extract with the same
pinned Planetiler image. It is small and quick next to the base map: on the
Berlin extract (100 MB) the street detail run took 8 seconds, peaked at about
1.3 GB of the default 2 GB heap and wrote 17.9 MB.

TileServer GL serves it at `/tiles/data/street_detail.json`. The API asks the
tile server which archives it serves, and the web app shows street detail
whenever `street_detail` is there. Coverage is your extract: outside it the 3D
view has no street detail, while forests still grow everywhere.

Rebuild `street_detail.mbtiles` after updating OpenMapX to get stop and give-way
signs in the 3D view and the lane highlight in 3D navigation: the build now
writes the signs, and each road keeps its OpenStreetMap way id, which the lane
highlight matches against the route. An older archive keeps working; it simply
has no signs and no lane highlight.

### Street detail with a hosted base map

To keep OpenFreeMap or MapTiler as the base map and still get street detail,
set this in `infra/docker/.env` before building:

```dotenv
TILESERVER_BASEMAP=hosted
```

The build then skips the base map run and writes only `street_detail.mbtiles`;
an earlier `tiles.mbtiles` is removed when the new build is promoted. TileServer
GL starts with `--ignore-missing-files`, so it serves whichever archives exist,
and because the base map archive is missing, the map uses the hosted base map
from **Admin → Settings → Map** and draws the street detail on top. Unset, or
`build`, builds both. In this mode, offline packages cannot be made from local
tiles, because they read `tiles.mbtiles`. The street data may be a little older
or newer than the hosted base map.

If you override `services/tileserver/config/config.json` (see
[Managing services](../install/managing-services.md)), keep the `street_detail`
entry beside `openmapx`. Prepared tile builds made before street detail existed
are reported as incomplete until you rebuild; they keep serving the base map
meanwhile.

## Relief and contours

The Terrain option keeps the active vector style, adding multidirectional
hillshade and contour lines underneath its roads and labels. It also enables
MapLibre's elevation surface, so a pitched map shows 3D terrain. With
self-hosted vector tiles, Terrain uses Mapterhorn's Terrarium DEM through the
OpenMapX API proxy and generates contours in a browser worker. No MapTiler key
is needed for this terrain source. The visible map credit links to Mapterhorn's
full source attribution, which includes the underlying elevation providers.
The browser contacts OpenMapX for DEM tiles, not Mapterhorn directly.
Mapterhorn publishes the [tile endpoint](https://mapterhorn.com/data-access/)
for interactive maps and a [source-by-source license and attribution
catalog](https://mapterhorn.com/attribution/). Its terrain data is assembled
from open-data sources with attribution requirements; the Mapterhorn link in
the map footer is the project's consolidated upstream credit. The contour
renderer, `maplibre-contour`, is [BSD-3 licensed](https://github.com/onthegomap/maplibre-contour/blob/main/LICENSE)
and is bundled with the web app. For a custom DEM, operators must supply the
correct credit and verify that dataset's terms separately.
Mapterhorn documents public tile access but does not publish a service-level
capacity or availability commitment; high-volume deployments can serve its
downloadable PMTiles themselves, subject to the same source attributions.

With a MapTiler basemap, Terrain keeps MapTiler Terrain RGB and MapTiler
Contours through the existing API proxy; `MAPTILER_API_KEY` is required. MapTiler's
terrain datasets have a native maximum zoom of 14. Mapterhorn's worldwide DEM
supports contours through zoom 12; higher-resolution elevation tiles are
available in some regions, and closer views overzoom where necessary.

The Default street map uses the same DEM for soft mountain shading: a plain
hillshade from zoom 6 that fades out by zoom 14, with no contours, elevation
tint or 3D terrain. It requests DEM tiles only up to zoom 9 and overzooms them,
which keeps the shading generalised and the tile count low. Satellite and
Cycling load no elevation data.

A deployment with its own DEM can set `NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL` to
a locally served DEM TileJSON endpoint and set
`NEXT_PUBLIC_TERRAIN_DEM_ENCODING` to `mapbox` (default) or `terrarium`. For
browser-generated contours, the app reads the tile URL from TileJSON. You can
set `NEXT_PUBLIC_TERRAIN_DEM_TILE_URL_TEMPLATE` to its local `{z}/{x}/{y}` tile
URL to skip that extra TileJSON request. Alternatively, set
`NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL` to a vector TileJSON endpoint with a
`contour` source layer and `height`/`nth_line` fields. Set
`NEXT_PUBLIC_TERRAIN_ATTRIBUTION_NAME` and
`NEXT_PUBLIC_TERRAIN_ATTRIBUTION_URL` to the data provider's required credit.

The web runtime reads `NEXT_PUBLIC_TERRAIN_DEM_TILE_URL_TEMPLATE` and
`NEXT_PUBLIC_TERRAIN_DEM_ENCODING`, but the current `web` service manifest
does not forward those two variables. Setting them only in the managed `.env`
therefore does not apply them to that container. Verify the effective web
container environment before relying on a custom encoding/template; the
forwarded TileJSON and attribution settings remain available. A custom manifest
or non-Compose runtime must supply the missing variables explicitly.

Downloaded browser packages currently contain OpenMapTiles vectors and glyphs,
but no elevation or contour tiles. While an offline package is active, Default
and Terrain therefore show the flat vector style and make no terrain tile
requests.

## Offline packages

Offline package generation reads the same `tiles.mbtiles` and `tile-fonts`
trees. Street detail and forests are not part of offline packages. A browser package consists of:

- one immutable, checksummed PMTiles archive for the selected bounds and zooms;
- versioned glyph PBFs needed by the bundled OpenMapX light/dark styles; and
- a small manifest describing coverage, checksums, schema, attribution, and the
  glyph namespace.

Style JSON and sprites are not copied into each package. The service worker
installs the same bundled styles and sprites used online, and the offline
MapLibre style rewrite changes only the vector source and glyph template. With
multiple downloaded areas, MapLibre still receives one `openmaptiles` source
and one layer set, so overlapping packages cannot duplicate labels or fills.

See [Offline maps and navigation](../features/offline-maps.md) for browser
storage, validation, and navigation-continuation behavior.

## Updating data

To refresh glyphs or the regional tile archive:

```bash
pnpm openmapx data download fonts
pnpm openmapx data download osm europe/germany
pnpm openmapx services stop tileserver
pnpm openmapx services build tileserver --region europe/germany
pnpm openmapx data link
pnpm openmapx services start tileserver
```

`openmapx data update` includes glyphs but builds every installed buildable
engine, including unselected ones; use targeted commands for a tile-only refresh. Existing browser packages remain immutable; preparing the same area
against refreshed source data produces a new content-addressed identity.

## Martin overlays

Martin serves PostGIS tile functions as dynamic vector tile endpoints. It
serves only the sources declared in the release's `services/martin/config/martin.yaml`
(or your [override](../install/managing-services.md#service-file-overrides) of it),
the traffic-flow overlay's `segment_flow`, and logs in as
`openmapx_tiles`, a role that can call the functions in the `tiles` schema and
read no table. Set its password before enabling Martin; PostGIS applies it on
its next start:

```bash
# Generate a value, then set MARTIN_DB_PASSWORD once in infra/docker/.env:
openssl rand -hex 32
# In a planned database maintenance window:
pnpm openmapx services start postgis
pnpm openmapx services enable martin
pnpm openmapx compose render
pnpm openmapx services start martin
curl -sf http://localhost:3002/health
```

The functions in `tiles` run as `openmapx_tiles_owner`, a role that cannot log
in, is no superuser and only reads. The traffic-flow function calls
OpenConditions' `conditions.segment_flow`, which reads OpenConditions' tables
through OpenConditions' own helper functions. OpenMapX grants
`openmapx_tiles_owner` nothing in `conditions`. OpenConditions' ingest
service grants it, at every start after migrating, exactly what the tile
function reads: `SELECT` on `road_segment`, `segment_speed`, `source` and
`public_license_policy`, and `EXECUTE` on `segment_flow`,
`flow_public_licenses` and `flow_osm_credit`. Traffic tiles therefore render
as soon as OpenConditions has migrated, with no PostGIS restart, the role
never writes, and it cannot read OpenConditions' credentials or crowd
reports. A backup restore keeps the grants while the role exists; after a
restore into a cluster whose roles had to be created again, restarting the
ingest service grants them again. If an OpenConditions release does not grant
them, a traffic tile request fails with
`permission denied for schema conditions` (or for one of its tables) in
Martin's log, and no code runs with more rights; see
[Community extensions](../administration/community-extensions.md#configuring-the-openconditions-services).

PostGIS grants every role read access to its own catalogue tables:
`spatial_ref_sys`, `geometry_columns` and `geography_columns`. The tile roles
can read them as well.

Only the superuser can create or replace the functions in `tiles`, and only
the superuser and the owner of `conditions` those in `conditions`. Until
OpenConditions creates `conditions`, any role with `CREATE` on the database
other than the API's and data-manager's could create it, so grant that right
only to the services that need it. The tile roles may create no objects of
their own.

The tile functions and Martin's login find PostGIS in the superuser's
`extensions` schema and never search `public`, so no function the API creates
can run as the tile owner; see
[Database roles](../install/configuration.md#database-roles).

Martin is independent of TileServer GL. Most deployments that only need a
self-hosted base map need TileServer GL, not Martin.

## Related documentation

- [Preparing data](../install/preparing-data.md)
- [Managing services](../install/managing-services.md)
- [Map layers & overlays](../features/map-layers.md)
- [Configuration](../install/configuration.md)
- [Service manifest reference](../developer/service-manifest.md)

## Hosted source and attribution

[OpenFreeMap](https://openfreemap.org/) uses the OpenMapTiles schema and needs no
API key. Its public service has no SLA; operators can select another hosted
source or their own tiles. The footer credits OpenStreetMap and OpenMapTiles,
plus the selected hosted provider. Local/offline tiles do not display a hosted
provider credit. OpenFreeMap and self-hosted basemaps default to proxied
Mapterhorn terrain and generated contours, keeping Terrain keyless too.

If the public configuration API is unavailable or returns invalid configuration,
the page preserves explicit local URLs or tries the conventional `/tiles` paths.
It does not silently switch a potentially self-hosted instance to a third party.
A hosted deployment can consequently show an unavailable map during an API
outage; reload after the API recovers to retry provider discovery.
