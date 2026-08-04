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

Without self-hosted URLs, the bundled style reads MapTiler-hosted vector tiles
and glyphs through the API proxy. A self-hosted deployment can replace those two
data endpoints with TileServer GL. It does not download or maintain a second set
of server-side styles.

Martin is separate: it generates optional overlay tiles from PostGIS and does
not provide the base map.

## TileServer GL inputs

The `tileserver` service consumes only prepared map data:

| Input | Mounted at | Produced by |
| --- | --- | --- |
| `tile-mbtiles` | `/data/mbtiles` | `openmapx services build tileserver` |
| `tile-fonts` | `/data/fonts` | `openmapx data download fonts` |

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
pnpm openmapx data build tiles europe/germany
```

Planetiler writes `data/tile-mbtiles/tiles.mbtiles`. Stop TileServer GL before
replacing a running archive:

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
assets. Restart `app-web` after changing these values.

`NEXT_PUBLIC_STYLE_PROVIDER=maptiler` selects MapTiler's complete hosted style
through the API and does not use the local OpenMapX offline-package pipeline.

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
