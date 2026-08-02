---
title: Self-hosting map tiles
description: Serve your own base map from OpenStreetMap data with TileServer GL and Martin, and point the web app at it instead of MapTiler Cloud.
sidebar_position: 5
---

# Self-hosting map tiles

The base map — the roads, water, land use, and labels drawn underneath
everything else — uses the bundled OpenMapX style by default. When no
self-hosted tile URLs are configured, that style gets its vector tiles and
glyphs from the MapTiler Cloud fallback through the API. OpenMapX can also run
the entire base-map stack on your own infrastructure and open data. This guide
covers that path: building vector tiles from an OpenStreetMap extract, serving
them, and switching the web app over.

Two services do the work, and they have different jobs:

- **TileServer GL** serves the **base map** — prebuilt OpenMapTiles vector tiles,
  plus the styles, fonts, and sprites needed to draw them. This is the one you
  enable to replace the MapTiler fallback.
- **Martin** serves **dynamic vector tiles straight from PostGIS**, generated on
  the fly from database tables. It's a separate, optional piece for data that
  lives in your database rather than in a prebuilt tile archive.

Both are services in the sense of [Managing services](../install/managing-services.md):
each has a `service.json` manifest, is opt-in, and is reached over Traefik once
enabled. Neither is part of the always-on core.

## TileServer GL — the self-hosted base map

TileServer GL is a MapLibre/Mapbox tile server. It reads three kinds of prepared
input — a vector tile archive (MBTiles), font glyph stacks, and map style bundles
— and serves them over HTTP so the browser can render a complete map without ever
talking to an external tile provider.

The manifest (`services/tileserver/service.json`) runs the
`maptiler/tileserver-gl:latest` image with a 2 GB memory limit, listening on
container port `8080`. It declares three `consumes` inputs that the renderer
wires in from the data-manager:

| Input         | Mounted at      | Produced by                                |
| ------------- | --------------- | ------------------------------------------ |
| `tile-mbtiles` | `/data/mbtiles` | `openmapx services build tileserver`       |
| `tile-fonts`   | `/data/fonts`   | `openmapx data download style`             |
| `tile-styles`  | `/data/styles`  | `openmapx data download style`             |

Its `exposure.proxy` block puts it behind Traefik at the `/tiles` prefix (stripped
before forwarding), so on a live deployment it answers at
`https://${DOMAIN}/tiles/`. The manifest also binds a host port on
`127.0.0.1:8080` for local inspection. There's a preset, `tiles`, that resolves to
exactly this service.

### Step 1 — download the style assets

A tile archive on its own is just geometry; to draw it you also need the styles
(which layers to draw and how), the fonts (glyphs for labels), and the sprites
(icons). One command fetches all of them:

```bash
pnpm openmapx data download style
```

This downloads the OpenMapTiles font glyph stacks into `data/tile-fonts/` and four
map styles — **osm-bright**, **dark-matter**, **positron**, and **osm-liberty** —
with their sprite sheets into `data/tile-styles/`. As it pulls each style in, the
data-manager **rewrites** the `style.json` so TileServer GL serves everything
locally: vector sources are repointed at the local MBTiles
(`mbtiles://{openmapx}`), glyphs at the mounted fonts, and sprites at the
sibling sprite files. After this step nothing in the styles references the
network at render time.

You only need this if you're self-hosting tiles. If you rely on the MapTiler
fallback, skip it. See [Preparing data](../install/preparing-data.md#map-styles-fonts-and-sprites)
for where these files land.

### Step 2 — build the vector tiles for your region

The MBTiles archive is built from an OpenStreetMap extract, so download the
extract first and then build:

```bash
pnpm openmapx data download osm europe/germany
pnpm openmapx services build tileserver --region europe/germany
```

The build runs [Planetiler](https://github.com/onthegomap/planetiler) inside a
Docker helper (`ghcr.io/onthegomap/planetiler:latest`), converting the extract
into the OpenMapTiles schema and writing
`data/tile-mbtiles/tiles.mbtiles`. There's a shorthand alias if you're thinking in
terms of data rather than services:

```bash
pnpm openmapx data build tiles europe/germany
```

Region size drives everything here — a single country builds in minutes and
produces a few gigabytes; the planet is tens of gigabytes and wants on the order
of 30 GB of RAM for the build (Planetiler is invoked with `-Xmx30g`). Unlike the
region-scale routing engines, TileServer GL is happy with a `planet` archive, so
worldwide coverage is on the table. See [Requirements](../install/requirements.md)
for sizing.

:::caution[Stop the server before rebuilding]
The build stages a new `tiles.mbtiles` into the directory the running container
reads from, so it refuses to run while `tileserver` is up. Stop it first
(`pnpm openmapx services stop tileserver`), build, then start it again. Rebuilds
are skipped entirely when the source extract hasn't changed.
:::

### Step 3 — enable, wire, and start

Enable the service, render the stack so the consumes/produces matches turn into
mounts, apply the hardlinks, and start it:

```bash
pnpm openmapx services enable tileserver
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start tileserver
```

`data link` is what actually connects the producer directories
(`data/tile-mbtiles`, `data/tile-fonts`, `data/tile-styles`) to the read-only
paths the container mounts — see
[Sharing data with hardlinks](../install/preparing-data.md#sharing-data-with-hardlinks).
With the container up, you can sanity-check it from the host:

```bash
# The styles the server is offering
curl -s http://localhost:8080/styles.json

# A single style document
curl -s http://localhost:8080/styles/osm-bright/style.json

# A vector tile at z/x/y
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:8080/data/openmapx/0/0/0.pbf
```

TileServer GL also serves a built-in preview viewer at the root URL, which is the
quickest way to confirm a style is rendering before you touch the web app.

### Step 4 — point the web app at your tiles

The web app decides where the base map comes from at request time, from a small
set of `NEXT_PUBLIC_*` variables in `infra/docker/.env` (baked into the web
container's per-request environment). The key one is the provider switch:

```bash
# infra/docker/.env
NEXT_PUBLIC_STYLE_PROVIDER=openmapx
NEXT_PUBLIC_MAP_STYLE_URL=https://maps.example.com/tiles
NEXT_PUBLIC_TILES_URL=https://maps.example.com/tiles/data/openmapx.json
```

There are two ways the web app can consume your tile server, and the difference is
worth understanding:

- **`NEXT_PUBLIC_STYLE_PROVIDER=maptiler` with `NEXT_PUBLIC_MAP_STYLE_URL` set** —
  the app loads one of TileServer GL's *own* styles directly. It appends
  `/styles/<style>/style.json` to the base URL, mapping its internal style names
  (default, dark, satellite) onto the bundled osm-bright / dark-matter styles.
  This is the "serve TileServer GL's styles as-is" route.
- **`NEXT_PUBLIC_STYLE_PROVIDER=openmapx`** — the app loads the **OpenMapX style**
  it ships itself (see below) and points only its *vector source* at your tiles,
  via `NEXT_PUBLIC_TILES_URL` (a TileJSON endpoint your tile server exposes, e.g.
  `…/tiles/data/openmapx.json`). Fonts come from `NEXT_PUBLIC_MAP_STYLE_URL/fonts`
  when that's set. This is the route that gives you a polished street-map look on
  top of your own tiles.

Out of the box `NEXT_PUBLIC_STYLE_PROVIDER` defaults to `openmapx`, so a fresh
instance renders the OpenMapX house style. Its vector tiles and glyphs, however,
proxy from MapTiler Cloud through the API until you point `NEXT_PUBLIC_TILES_URL`
(and fonts) at your own tile server — so the default experience is the OpenMapX
style over MapTiler-hosted tiles. When you do serve your own tiles, the base URL
with the built-in Traefik route is `${DOMAIN}/tiles`; for local development
against the host port it's `http://localhost:8080`.

After changing these, apply the web service so it picks up the new environment:

```bash
pnpm openmapx services start app-web
```

## The OpenMapX style

OpenMapX ships its own MapLibre style, tuned to look like a familiar consumer map
rather than a raw OpenMapTiles demo. It lives in the web app itself at
`apps/web/public/styles/openmapx-streets.json` (served at `/styles/openmapx-streets.json`)
and is what `NEXT_PUBLIC_STYLE_PROVIDER=openmapx` selects.

Because it's a self-contained style document, the app fills in the
deployment-specific pieces at load time: the vector source URL becomes your
`NEXT_PUBLIC_TILES_URL`, the glyph endpoint resolves to your fonts, and sprites
load from the bundled sprite sheet alongside the style. Source attribution is
deliberately stripped from the style and contributed by the app's own attribution
machinery, so credits stay consistent across base map and overlays. The net
effect: the OpenMapX style works against either MapTiler Cloud or your
self-hosted TileServer GL — it's the *style*, independent of where the tiles come
from. The four downloaded styles (osm-bright and friends) are the alternative,
TileServer-native option for operators who'd rather serve a stock OpenMapTiles
style.

These base styles are also what the **layer picker** exposes as Default, Satellite,
and Terrain — see [Map layers & overlays](../features/map-layers.md) for the
user-facing side.

## Martin — dynamic tiles from PostGIS

Martin is a different tool for a different need. Where TileServer GL serves a
prebuilt archive, **Martin generates vector tiles on demand from your PostGIS
database** — it scans the connected database at startup and publishes every table,
view, and tile function with a geometry column as a tile endpoint, with no build
step and no data files of its own.

The manifest (`services/martin/service.json`) runs `ghcr.io/maplibre/martin:latest`
on container port `3000`, depends on `postgis` being healthy, and connects via a
`DATABASE_URL` pointing at the shared `openmapx` database. It's exposed behind
Traefik at `/martin` (and on `127.0.0.1:3002` on the host), and has its own preset,
`martin`. Since it reads live from the database, enabling it is the whole setup:

```bash
pnpm openmapx services enable martin
pnpm openmapx compose render
pnpm openmapx services start martin
```

```bash
# Catalog of auto-discovered sources
curl -s http://localhost:3002/catalog

# Martin's own health check
curl -sf http://localhost:3002/health
```

Martin is the right place to serve geospatial data you've loaded into PostGIS —
imported datasets, application-managed tables — as map layers, complementing the
base map rather than replacing it. It is independent of TileServer GL; you can run
either, both, or neither. Most deployments that just want a self-hosted base map
need only TileServer GL.

## Verifying and updating

To refresh the base map after an OSM update, rebuild and bounce the server:

```bash
pnpm openmapx data download osm europe/germany
pnpm openmapx services stop tileserver
pnpm openmapx services build tileserver --region europe/germany
pnpm openmapx data link
pnpm openmapx services start tileserver
```

To refresh just the styles (for example after an upstream style fix), re-run the
style download and restart:

```bash
pnpm openmapx data download style
pnpm openmapx services restart tileserver
```

The one-command [`data update`](../install/preparing-data.md#a-full-refresh-in-one-command)
refresh includes the style download and the tile build for any buildable service
in your selection, so if `tileserver` is enabled it's covered there too.

## Where to go next

- **[Preparing data](../install/preparing-data.md)** — the download/build/link
  pipeline these commands plug into, in full.
- **[Managing services](../install/managing-services.md)** — enabling, rendering,
  exposure, and the service lifecycle.
- **[Map layers & overlays](../features/map-layers.md)** — how the base styles and
  overlays appear to users.
- **[Configuration](../install/configuration.md)** — `.env`, secrets, and the
  admin panel.
- **[Service manifest reference](../developer/service-manifest.md)** — the fields
  behind `consumes`, `produces`, and `exposure`.
