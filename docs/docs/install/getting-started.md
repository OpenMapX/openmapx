---
title: Getting started
description: A step-by-step walkthrough from a fresh clone to a running OpenMapX stack with Docker Compose.
sidebar_position: 2
---

# Getting started

This page takes you from a fresh clone of the monorepo to a running OpenMapX
stack. It's a happy-path walkthrough: you'll bring up the lightweight core, hand
the data-manager some source data, and start the app — all driven by the
`openmapx` CLI.

Everything runs as Docker containers, and there is no hand-maintained compose
file. You enable the [services](../overview/how-it-works.md) you want, render a
`docker-compose.generated.yml` from their manifests, and bring the stack up. The
deeper reference pages — [Managing services](./managing-services.md) and
[Preparing data](./preparing-data.md) — go further than this walkthrough does;
come here first, then follow those when you need the detail.

Before you start, make sure your host meets the [requirements](./requirements.md):
a 64-bit Linux host with Docker Engine, the Compose v2 plugin, Node.js 24+, and
`pnpm`. The CLI runs the TypeScript sources directly — there's no build step.

:::note[`docker compose`, not `docker-compose`]
OpenMapX uses Compose v2, which ships as the `docker compose` subcommand of the
Docker CLI. The standalone v1 `docker-compose` binary is not supported.
:::

## 1. Clone and install

Clone the repository and install the workspace once. `pnpm install` sets up the
monorepo and the `openmapx` CLI; you never install anything globally.

```bash
git clone https://github.com/OpenMapX/openmapx.git
cd openmapx
pnpm install
```

From here on, every command is run as `pnpm openmapx <command>` from the repo
root.

## 2. Configure your environment

A Docker deployment reads exactly one environment file: `infra/docker/.env`.
Docker Compose loads it automatically, and the `openmapx` CLI loads it too, so
the same values reach both the rendered stack and the CLI. Copy the example to
get started:

```bash
cp infra/docker/.env.example infra/docker/.env
```

Open `infra/docker/.env` and set, at minimum, the values the stack refuses to
start without. The generated compose file references several of these with the
`${VAR:?}` form, so a missing one fails the boot loudly rather than shipping an
insecure default:

```bash
# Public domain + TLS (Traefik / Let's Encrypt)
DOMAIN=openmapx.example.com
ACME_EMAIL=admin@example.com

# Database — generate with: openssl rand -hex 32
POSTGRES_PASSWORD=

# Auth secrets
BETTER_AUTH_SECRET=        # npx @better-auth/cli@latest secret
OPENMAPX_SECRETS_KEY=      # openssl rand -hex 32

# Internal service auth — generate each with: openssl rand -hex 32
DATA_MANAGER_AUTH_TOKEN=   # app-api ↔ data-manager
OPENMAPX_LOCAL_ADMIN_TOKEN= # CLI ↔ loopback admin

# Host wiring (Linux)
OPENMAPX_HOST_DIR=         # absolute path of this checkout — run `pwd` here
DOCKER_GID=                # docker-socket group id — `stat -c %g /var/run/docker.sock`
```

`OPENMAPX_HOST_DIR` and `DOCKER_GID` let the app-api and data-manager containers
drive Docker on the host, so the CLI's lifecycle and data commands work from
inside the stack. The `.env.example` file documents how to generate each secret
inline.

Everything else — map-tile keys, traffic and street-imagery tokens, OAuth login,
per-integration credentials — is optional at boot and mostly managed from the
admin panel after the stack is up. For the full reference, see
[Configuration](./configuration.md).

:::tip[Tile provider]
The default `NEXT_PUBLIC_STYLE_PROVIDER=maptiler` renders maps from MapTiler
Cloud and needs a `MAPTILER_KEY`. You can leave the key unset for now and add it
from the admin UI later, or self-host tiles with the `tileserver` service.
:::

## 3. Enable a minimal set of services

OpenMapX separates an always-on core from the optional, heavier backend engines.
If you do nothing, the default selection is just the core:

- `traefik` and `well-known` (reverse proxy + passkey/well-known files)
- `app-api` and `app-web` (the Fastify API and the Next.js frontend)
- `postgis` and `redis` (database + cache)
- `data-manager` (owns the `/data` tree and downloads source data)

That core renders maps and serves the app, but self-hosted search, routing, and
transit come from the optional engines you opt into. For a first boot, a small
self-hosted stack is a good target — a lightweight geocoder and a regional
router:

```bash
pnpm openmapx services enable photon osrm
```

This persists your choice to `infra/docker/service-selection.json`; the renderer
expands each root into its dependencies automatically, so you only list the
engines you actually want. You can confirm what's effectively selected with:

```bash
pnpm openmapx services selected
```

To skip the heavy engines entirely and run the core against hosted endpoints
instead, just don't enable anything here — the default core selection is enough
to bring the app up. See [Managing services](./managing-services.md) for the full
list of engines, presets, and how capability bindings work.

## 4. Render the compose stack

Generate the compose file from your enabled service manifests:

```bash
pnpm openmapx compose render
```

This reads `infra/docker/.env` (so it picks up `DOMAIN` automatically) and
writes two files, both gitignored:

- `infra/docker/docker-compose.generated.yml` — the actual compose file
- `infra/docker/docker-compose.generated.hardlinks.json` — the plan that maps
  downloaded source files to per-service consumer paths

Re-render any time `.env`, the service selection, or a manifest changes — the
output is deterministic. Many CLI commands (`services start`, `data link`,
`compose up`) re-render for you, so you rarely run this by hand after the first
time.

## 5. Bring up the infrastructure first

Start the database, cache, proxy, and data-manager before anything else. The
data-manager needs its `/data` volume mounted before you can ask it to download
anything:

```bash
pnpm openmapx services start postgis redis traefik data-manager
```

Confirm the data-manager is healthy:

```bash
curl -s http://localhost:4000/status
```

You should see a small JSON object reporting `"ok": true` and `"dataDir":
"/data"`. If the call fails, give the container a few seconds to finish starting
and try again.

## 6. Download source data

The data-manager does the actual fetching; the CLI is a thin client over its
HTTP API. Download an OSM extract for the region you care about — regions follow
the [Geofabrik](https://download.geofabrik.de/) layout (`europe/germany`,
`north-america/us`, `planet`, …):

```bash
pnpm openmapx data download osm europe/germany
```

Then grab the bundled map styles, fonts, and sprites used by the frontend and
self-hosted tiles:

```bash
pnpm openmapx data download style
```

If you're running a transit engine, also pull GTFS feeds (via the
community-curated Transitous catalog), filtered to the countries you want:

```bash
pnpm openmapx data sync --countries de,at,ch
```

Inspect what's been downloaded at any time:

```bash
pnpm openmapx data status
```

:::tip[Set a default region once]
Set `OPENMAPX_REGION=europe/germany` in `infra/docker/.env` and you can drop the
positional region from `data download osm` (and the build commands below). A
region passed on the command line still wins for that one run.
:::

[Preparing data](./preparing-data.md) covers custom feed lists, per-feed API
keys, and how the hardlink sharing works under the hood.

## 7. Build prepared artifacts

Some engines need an explicit build step that turns the downloaded OSM/GTFS data
into the graph or index they serve from. For the regional router we enabled
above (`osrm`), run its build — Photon downloads a prebuilt index on first start,
so it needs no build here:

```bash
pnpm openmapx services build osrm --region europe/germany
```

`--region` is optional; without it the build falls back to a service-specific
env default, then `OPENMAPX_REGION`, and finally the single OSM extract on disk
if there's exactly one. Other buildable engines (`motis`, `otp`, `tileserver`,
`pelias`) follow the same pattern. To build every selected buildable service in
one pass:

```bash
pnpm openmapx services build-all --region europe/germany
```

Heavier engines that aren't in this list (Valhalla, Nominatim, Overpass) build
their indexes from the OSM extract on first container start instead — that
happens automatically when the stack comes up, and it can take hours at large
scale.

## 8. Apply the hardlink plan

Link the downloaded source files into each consuming service's data directory.
The data-manager creates filesystem hardlinks, so every consumer sees its own
copy at zero extra disk cost:

```bash
pnpm openmapx data link
```

This re-renders the compose plan first (so the links match your current service
selection) and then applies it. `build`, `build-all`, and `compose up` run this
step for you, but it's worth knowing as its own command for when you refresh data
without rebuilding.

## 9. Bring up the full stack

Finally, start everything:

```bash
pnpm openmapx compose up
```

This re-renders, applies the hardlink plan, and runs `docker compose up -d` for
the whole enabled selection. Prepared services start from the artifacts you built
in step 7; any heavy engine builds its internal index from the OSM extract on
first start, which is slow at continent or planet scale.

Watch progress with:

```bash
pnpm openmapx services status            # container state for every service
pnpm openmapx services logs <id> --follow # tail one service's logs
```

:::tip[Bring heavy engines up one at a time]
On modest hardware, starting several heavy indexers at once can saturate CPU,
disk, and RAM. The indexers are independent, so it's usually better to start one,
wait for it to finish its initial build (CPU and disk I/O quiet down, and
`services status` reports it healthy), and only then start the next. See
[Managing services](./managing-services.md) for a staggered-startup order.
:::

## 10. Create your first admin user

Open `https://your-domain` in a browser and sign up through the web UI. Traefik
obtains a Let's Encrypt certificate automatically on the first request, once your
domain's DNS points at the host. Then promote your account to admin from the repo
root:

```bash
pnpm openmapx users promote you@example.com
```

That account now has access to `/admin`, where you manage integrations, service
config, capability bindings, data workflows, and the rest of the operations
surface.

## Where to go next

- **[Configuration](./configuration.md)** — the full `infra/docker/.env`
  reference, including the optional keys this walkthrough skipped.
- **[Managing services](./managing-services.md)** — the engine catalog, presets,
  capability bindings, and staggered startup for heavy backends.
- **[Preparing data](./preparing-data.md)** — custom GTFS feeds, per-feed API
  keys, region selection, and how hardlink sharing works.
- **[Upgrading](./upgrading.md)** — pulling new code and images, and refreshing
  source data.
