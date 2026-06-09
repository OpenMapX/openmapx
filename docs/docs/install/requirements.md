---
title: Requirements
description: Software prerequisites and hardware sizing for self-hosting OpenMapX, from the lightweight core to full self-hosted routing, geocoding, and transit.
sidebar_position: 1
---

# Requirements

OpenMapX runs as a set of Docker containers driven by the `openmapx` CLI, all
from a single cloned copy of the monorepo. This page lists what the host needs
before you start, and how the hardware requirements scale with the backend
engines you choose to enable.

The most important thing to know up front: **OpenMapX is modular.** The core
application — the web frontend, the API, the database, the cache, and the data
manager — is lightweight. Everything heavy (self-hosted routing, geocoding,
transit, OSM queries, tiles) is an optional [service](../overview/how-it-works.md)
you opt into. You only pay the RAM and disk cost of the services you actually
run, and any one of them can be left out in favor of a hosted endpoint.

## Software prerequisites

Everything is run from a clone of the repository; there is nothing to install
globally beyond the host tooling below.

| Software           | Version          | Why it's needed                                                      |
| ------------------ | ---------------- | ------------------------------------------------------------------- |
| **Docker Engine**  | recent (27+)     | Runs every OpenMapX service as a container                          |
| **Docker Compose** | v2              | Orchestrates the generated stack (`docker compose`, not `docker-compose`) |
| **Node.js**        | 24 or newer      | Runs the `openmapx` CLI directly off TypeScript — no build step      |
| **pnpm**           | 11 (`pnpm@latest`) | Workspace package manager for the monorepo                         |
| **git**            | any              | Cloning the repo and any community service repositories             |

A few notes:

- The CLI is invoked as `pnpm openmapx <command>` from the repo root. It auto-loads
  `infra/docker/.env`, the single environment file a Docker deployment reads.
- The required Node and pnpm versions are pinned in the repo's root `package.json`
  (`engines.node` and `packageManager`). Use `pnpm install` once after cloning to
  set up the workspace.
- OSM and GTFS downloads, PBF conversion, and the heavy build steps all run inside
  Docker helper images. You do **not** need `osmium`, `jq`, `unzip`, or similar
  tools installed on the host.

:::note `docker compose`, not `docker-compose`
OpenMapX uses Compose v2, which ships as the `docker compose` subcommand of the
Docker CLI. The standalone v1 `docker-compose` binary is
[deprecated](https://docs.docker.com/compose/releases/migrate/) and is not
supported. See the [Docker install docs](https://docs.docker.com/engine/install/)
to set up Engine and the Compose plugin.
:::

### Operating system

A 64-bit Linux host (Ubuntu, Debian, and similar) is the supported and
recommended platform — it gives the most predictable Docker experience and is
what production deployments run on. Docker Desktop on macOS or Windows works for
local exploration, but the heavy backend builds are demanding enough that a Linux
server is the right home for anything beyond the lightweight core.

## Hardware

There is no single hardware figure for OpenMapX, because the requirements depend
almost entirely on which services you enable and how large a geographic area you
cover. Two variables dominate:

- **Which engines you run.** A few of them — Nominatim, Overpass, Valhalla, MOTIS
  — are genuinely heavy. The core app and the lightweight engines are not.
- **The data scale.** A single country is modest; a continent is several times
  larger; the full planet is an order of magnitude more in both RAM and disk.

### Baseline: the core app

The always-on core — `traefik`, `well-known`, `app-api`, `app-web`, `postgis`,
`redis`, and `data-manager` — is what you get with the default service selection.
It needs only modest resources:

| Resource | Baseline (core only)        |
| -------- | --------------------------- |
| RAM      | ~4 GB                       |
| CPU      | 2 cores                     |
| Disk     | ~20 GB (plus downloaded data) |

On its own, the core renders maps and serves the app, but the self-hosted
search/routing/transit features come from the optional engines below. With every
heavy engine disabled, you can run OpenMapX against hosted endpoints (a hosted
tile provider, a public Valhalla, etc.) and stay close to this baseline.

### Engine sizing

Each optional service declares a memory ceiling in its manifest
(`services/<id>/service.json`). The table below lists those ceilings along with
the rough disk footprint of the data each engine builds. **The heavy engines are
called out** — running one or two of them at once is what pushes a host into the
16–64 GB range.

| Engine | Capability | RAM (manifest ceiling) | Disk (approx.) | Weight |
| ------ | ---------- | ---------------------- | -------------- | ------ |
| **Nominatim** | Full geocoding + reverse + enrichment | 64 GB | ~330 GB (planet) | **Heavy** — peak RAM during import |
| **Overpass** | OSM category/feature queries | 32 GB | ~200–300 GB (planet) | **Heavy** |
| **Valhalla** | Planet-scale routing | 16 GB | ~50–100 GB (planet) | **Heavy** |
| **MOTIS** | Planet-scale transit routing | 16 GB | ~50 GB | **Heavy** |
| **OTP** | Region-scale transit routing | 16 GB | ~10 GB (region) | Region-only |
| **Photon** | Lightweight search-as-you-type geocoding | 8 GB | ~200 GB (planet index) | Moderate |
| **OSRM** | Region-scale routing | 8 GB | ~30 GB (region) | Region-only |
| **Elasticsearch** (Pelias backend) | Composite geocoding store | 4 GB | ~100 GB (planet) | Moderate |
| **TileServer GL** | Self-hosted vector/raster tiles | 2 GB | ~80 GB (planet MBTiles) | Moderate |
| **Martin** | PostGIS dynamic vector tiles | — | shares PostGIS | Light |

A few patterns worth knowing:

- **Nominatim is the single biggest cost** — its 64 GB ceiling is the import-time
  peak; steady-state runtime use is far lower, but the import won't complete on a
  host that can't reach it (swap helps, slowly). It also produces the largest
  database (~330 GB at planet scale).
- **OSRM and OTP are region-scale only.** They load their graph fully into memory
  and don't fit a planet. For worldwide routing and transit, use **Valhalla** and
  **MOTIS** instead.
- **You usually want one geocoder, not three.** Photon (lightest, auto-downloads
  a prebuilt index), Nominatim (full-featured), and Pelias (composite, backed by
  Elasticsearch) overlap in purpose — pick the one that matches your needs.
- **Tiles are optional too.** If you point the web app at a hosted tile provider,
  you can skip TileServer GL and Martin entirely.

### Sizing by geographic scale

As a rough planning guide, once you account for the engines you've chosen:

| Scale          | RAM       | Disk               | CPU       |
| -------------- | --------- | ------------------ | --------- |
| Single country | 16 GB     | 200–500 GB SSD     | 4 cores   |
| Continent      | 32–64 GB  | 500 GB – 1 TB SSD  | 8 cores   |
| Planet         | 64+ GB    | 2+ TB NVMe SSD     | 16 cores  |

These are starting points for a host running the common set of engines at that
scale, not hard minimums. Trim the engine list and the numbers come down quickly.

:::tip Build once, run leaner
Several engines need far more RAM to build their indexes than to serve queries
afterward (Nominatim and Overpass especially). If you're tight on memory, bring
the heavy engines up one at a time and let each finish its initial import before
starting the next, rather than building them all in parallel.
:::

:::caution Disk is SSD, and headroom matters
The import and build phases are I/O-heavy and can briefly use far more disk than
the steady-state figures suggest (Nominatim's import peak is well above its final
~330 GB). Use SSD/NVMe storage on a filesystem with proper Unix ownership and
permissions, and leave generous free space before starting a planet build.
:::

## What the operator must provide

Beyond the host tooling, a production deployment needs a handful of values set in
`infra/docker/.env` (copied from `infra/docker/.env.example`). Compose refuses to
start until the required ones are present, so it's worth knowing them up front:

- **A domain and ACME email** (`DOMAIN`, `ACME_EMAIL`) for Traefik's automatic
  Let's Encrypt TLS.
- **Secrets** — `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `OPENMAPX_SECRETS_KEY`,
  `DATA_MANAGER_AUTH_TOKEN`, and `OPENMAPX_LOCAL_ADMIN_TOKEN`. The
  `.env.example` file documents how to generate each.
- **Host wiring** — `OPENMAPX_HOST_DIR` (the absolute path of the repo checkout)
  and `DOCKER_GID` (the host's docker-socket group id), both required so the
  app-api and data-manager containers can drive Docker.

External API keys for individual features (tiles, traffic, street-level imagery,
transit feeds) are mostly managed from the admin panel after the stack is up, not
in `.env`.

## Where to go next

- **[How it works](../overview/how-it-works.md)** — the service/integration model
  and how a deployment is wired together, so the engine choices above make sense.
- **[Getting started](./getting-started.md)** — the step-by-step deployment
  walkthrough.
