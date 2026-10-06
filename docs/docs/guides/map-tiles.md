---
title: Self-hosting map tiles
description: Serve OpenMapTiles vector data and glyphs while keeping the OpenMapX style in the web app.
sidebar_position: 5
---

# Self-hosting map tiles

OpenMapX always owns the base-map presentation. The light and dark style JSON,
sprites, layer order, and expressions ship with the web app. A deployment only
chooses where that style reads its OpenMapTiles vector data and font glyphs.
This keeps the online map, downloaded areas, previews, and dark-mode switches on
one visual definition.

Enabled TileServer GL is selected automatically; explicit `NEXT_PUBLIC_TILES_URL`
also always takes priority. Without local tiles, `BASEMAP_PROVIDER=auto` uses
MapTiler when its effective server-side key is configured, otherwise OpenFreeMap.
Choose `auto`, `openfreemap`, or `maptiler` in **Admin → Settings → Map → Hosted
Vector Basemap**, or set `BASEMAP_PROVIDER` to override the admin value. Reload
the page after an admin change. An explicit MapTiler choice without a key reports
missing configuration; it does not silently switch providers.

OpenFreeMap supplies OpenMapTiles-compatible vectors from its stable `/planet`
TileJSON and keyless Noto glyphs. The OpenMapX light/dark styles and sprites stay
unchanged. Its tiles/glyphs are requested directly by the browser; see the
[provider's privacy policy](https://openfreemap.org/privacy/). MapTiler assets use
the existing backend proxy and keep the key server-side. Neither selection changes
geocoding, satellite imagery or other provider-specific key requirements.

An enabled local server is never bypassed merely because a hosted preference is
set or a local request fails. Configure an explicit glyph base for external local
tiles; without one, glyphs use OpenFreeMap so labels do not require a MapTiler key.
The built-in TileServer GL supplies its own glyphs automatically. It does not
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

The equivalent data alias is:

```bash
pnpm openmapx data build tileserver europe/germany
```

Planetiler writes `data/tile-mbtiles/tiles.mbtiles`. It builds into
`data/tile-mbtiles.next/` and only replaces the archive once the build succeeds,
so a failed build keeps the old tiles. Its JVM heap defaults to half the PBF
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
curl -sf -o /dev/null http://localhost:8080/data/openmapx/0/0/0.pbf
curl -sf -o /dev/null 'http://localhost:8080/fonts/Noto%20Sans%20Regular/0-255.pbf'
```

### 4. Configure the web app

```bash
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
app and API normally use different origins. Restart `app-web` after changing
these values.

`NEXT_PUBLIC_STYLE_PROVIDER=maptiler` selects MapTiler's complete hosted style
through the API only when MapTiler is the resolved vector provider. Self-hosted
and OpenFreeMap vectors always use the owned styles. Complete hosted styles do
not use the local OpenMapX offline-package pipeline.

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
Contours through the existing API proxy; `MAPTILER_KEY` is required. MapTiler's
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

Downloaded browser packages currently contain OpenMapTiles vectors and glyphs,
but no elevation or contour tiles. While an offline package is active, Default
and Terrain therefore show the flat vector style and make no terrain tile
requests.

## Offline packages

Offline package generation reads the same `tiles.mbtiles` and `tile-fonts`
trees. A browser package consists of:

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

`openmapx data update` includes the font download and builds enabled prepared
artifacts. Existing browser packages remain immutable; preparing the same area
against refreshed source data produces a new content-addressed identity.

## Martin overlays

Martin publishes PostGIS tables, views, and tile functions as dynamic vector
tile endpoints. Enable it when application or integration data should be drawn
as an overlay:

```bash
pnpm openmapx services enable martin
pnpm openmapx compose render
pnpm openmapx services start martin
curl -sf http://localhost:3002/health
```

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
