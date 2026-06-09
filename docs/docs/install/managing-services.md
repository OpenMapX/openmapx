---
title: Managing services
description: Choose, enable, render, run, configure, and expose OpenMapX backend services with the openmapx CLI.
sidebar_position: 4
---

# Managing services

A **service** is a backend daemon that OpenMapX runs as a Docker container — a
database, a routing engine, a geocoder, a transit engine, a tile server. Each one
is described by a `service.json` manifest under `services/<slug>/`, and the
compose renderer turns the services you enable into a generated stack. See
[How it works](../overview/how-it-works.md) for the model; this page is about
operating those services day to day.

Everything here runs through the `openmapx` CLI from the repo root:

```bash
pnpm openmapx <command> [args]
```

The CLI auto-loads `infra/docker/.env` before it does anything, so the same
`DOMAIN`, secrets, and per-service overrides a Docker deployment reads are in
scope for every command.

## Seeing what's available

`services list` discovers and validates every `service.json` — both the
first-party services in `services/` and any community services you've installed
— and prints a compact table:

```bash
pnpm openmapx services list
```

```
ID            Version  Quality   Provides                            Enabled
data-manager  1.0.0    built-in  osm-data,gtfs-data,tile-asset-data  yes
nominatim     1.0.0    built-in  geocoder                            no
photon        1.0.0    built-in  geocoder                            no
postgis       1.0.0    built-in  database                            yes
redis         1.0.0    built-in  cache                               yes
...
```

A manifest that fails validation is left out of the table and a warning is
printed to stderr. Narrow the list with filters:

```bash
pnpm openmapx services list --capability geocoder       # only services that provide a capability
pnpm openmapx services list --quality built-in          # built-in | community-verified | community
pnpm openmapx services list --enabled                   # only services in the current selection
```

To inspect one service's full manifest:

```bash
pnpm openmapx services get valhalla
```

And to see the whole vocabulary of capabilities and shared data types across the
registry — who provides each, who consumes each:

```bash
pnpm openmapx services capabilities
pnpm openmapx services capabilities --unrecognised      # flag non-standard capability names
```

## Enabling and disabling services

The set of services that participate in your deployment is the **selection**.
The always-on core — `traefik`, `well-known`, `app-api`, `app-web`, `postgis`,
`redis`, and `data-manager` — is selected by default; everything heavy
(routing, geocoding, transit, OSM queries, tiles) is opt-in.

```bash
pnpm openmapx services enable valhalla photon          # add services to the selection
pnpm openmapx services disable osrm                    # remove services from the selection
```

These commands persist the change to `infra/docker/service-selection.json`, a
small file you can read and commit:

```json
{
  "selected": ["valhalla", "photon"]
}
```

You only list the **root** services you want. The renderer expands the rest
automatically — a service's `dependsOn`, the `traefik` proxy when a service
exposes a route, and any `data-manager` producer whose data a service consumes
all get pulled in. To see both the roots you asked for and the effective set
after expansion:

```bash
pnpm openmapx services selected
```

```
Source: file
Requested: valhalla, photon
Effective: traefik, well-known, app-api, app-web, postgis, redis, data-manager, valhalla, photon
```

The selection is resolved from the first source that's present, in this order:

1. an explicit `--services` flag on `compose render` / `compose up`
2. the `OPENMAPX_ENABLED_SERVICES` environment variable
3. `infra/docker/service-selection.json`
4. the built-in core defaults

When `OPENMAPX_ENABLED_SERVICES` is set, `enable` and `disable` refuse to edit
the file — the environment variable is the source of truth in that case, and the
CLI keeps it unambiguous.

:::note Selection is not the same as running
Editing the selection changes what *will* be rendered and started. It does not
touch running containers. Enabling a service is followed by a render and a start
(below) before it actually comes up.
:::

### Presets

A **preset** is a named bundle of root services, so you can say "start the
routing stack" instead of listing every id. Presets work on `services start`,
`stop`, `restart`, `recreate`, and on `compose render` / `compose up`:

| Preset      | Services                                                  |
| ----------- | --------------------------------------------------------- |
| `app`       | `app-api`, `app-web`, `well-known`                        |
| `proxy`     | `traefik`                                                 |
| `dev`       | `postgis`, `redis`                                        |
| `routing`   | `osrm`, `valhalla`                                        |
| `transit`   | `motis`, `motis-feed-proxy`, `otp`                        |
| `pelias`    | `pelias`, `pelias-pip`, `pelias-placeholder`, `elasticsearch` |
| `nominatim` | `nominatim`                                               |
| `photon`    | `photon`                                                  |
| `overpass`  | `overpass`                                                |
| `tiles`     | `tileserver`                                              |
| `martin`    | `martin`                                                  |

Presets compose, and they mix freely with explicit ids:

```bash
pnpm openmapx services start --preset app,proxy,dev
pnpm openmapx services start postgis --preset routing
```

## Rendering the stack

OpenMapX has no hand-maintained compose file. The renderer reads the enabled
manifests and writes the stack:

```bash
pnpm openmapx compose render
```

This produces two files under `infra/docker/`, both gitignored build outputs:

- `docker-compose.generated.yml` — the compose file every `docker compose -f …`
  command consumes
- `docker-compose.generated.hardlinks.json` — the plan that maps each consumer
  to its data producer (applied later by `openmapx data link`)

Render is deterministic — same manifests and `.env` in, same YAML out — so it's
cheap to re-run. Re-render any time the manifests, your `.env`, the selection, or
the registered community repos change. You can override the selection or domain
for a single render without touching the persisted selection:

```bash
pnpm openmapx compose render --services valhalla,photon
pnpm openmapx compose render --preset routing
pnpm openmapx compose render --domain maps.example.com
```

`--domain` defaults to `DOMAIN` from `infra/docker/.env`, so you rarely need it.

## Starting, stopping, and restarting

`services start` is the everyday command: it renders the full enabled stack,
applies the hardlink plan, and then `docker compose up -d` for the services you
name. Always pass the ids (or a preset) you want to bring up.

```bash
pnpm openmapx services start postgis redis data-manager
pnpm openmapx services start --preset app,proxy
```

To boot the whole enabled stack at once instead, use `compose up`, which renders
and then starts everything in the selection:

```bash
pnpm openmapx compose up
```

The remaining lifecycle commands are thin wrappers around `docker compose` and
expect a rendered compose file to already exist:

```bash
pnpm openmapx services stop motis otp                  # docker compose stop
pnpm openmapx services restart app-api                 # in-place reboot (does NOT re-render)
pnpm openmapx services recreate valhalla               # pull images + force-recreate
pnpm openmapx services status                          # container table (all services)
pnpm openmapx services status valhalla                 # one service
```

The distinction between `restart` and `start`/`recreate` matters:

- **`restart`** reboots the container in place. It does not re-render, so it
  won't pick up a changed manifest, `.env`, or selection — use it to bounce a
  service whose image and config are unchanged.
- **`start`** re-renders first, so it picks up compose-file changes.
- **`recreate`** re-renders, pulls the latest images, and force-recreates — the
  command to reach for after a `git pull` that bumps image tags.

For a single one-off check of the running containers across the stack:

```bash
pnpm openmapx check
```

## Viewing logs

```bash
pnpm openmapx services logs valhalla                   # last 100 lines
pnpm openmapx services logs valhalla --tail 500
pnpm openmapx services logs valhalla --follow          # stream
```

## Building prepared artifacts

A few engines can't boot from raw OSM data — they need a prepared graph or tile
set built first. Those services declare a build hook in their manifest; today
that's `osrm`, `otp`, `motis`, `pelias`, and `tileserver`. The build runs inside
a Dockerized helper, so you don't install `osmium` or friends on the host.

```bash
pnpm openmapx services build motis tileserver --region europe/germany
pnpm openmapx services build-all --region europe/germany
```

`--region` picks the OSM extract to build against. After a successful build, the
CLI re-renders and re-applies hardlinks so the new artifacts are wired into the
stack. Use `--continue-on-error` (on `build`) or `--fail-fast` (on `build-all`)
to control behavior when one service's build fails.

Building is only half the story — the source data those builds consume (OSM
extracts, GTFS feeds, map styles) is downloaded and refreshed separately. See
[Preparing data](./preparing-data.md) for the full data workflow, including the
one-command `data update` refresh that downloads, builds, renders, and links in
sequence.

## Configuring a service

Many services expose operator-tunable settings through a `configSchema` in their
manifest (Valhalla's elevation and admin-boundary toggles, for example). Values
resolve at render time through a three-layer cascade, highest priority first:

| Priority | Source                | Where it lives                              |
| :------: | --------------------- | ------------------------------------------- |
|    3     | Environment variable  | `SERVICE_<ID>_<KEY>` in `infra/docker/.env` |
|    2     | Database              | the admin panel's per-service config form   |
|    1     | Schema default        | the manifest's `configSchema` default       |

Environment variables always win, which keeps Docker deployments predictable.
The env-var name is `SERVICE_` + the uppercased service id (hyphens become
underscores) + `_` + the uppercased config key:

```bash
# infra/docker/.env
SERVICE_VALHALLA_BUILD_ELEVATION=false
PHOTON_REGION=germany
```

Because the cascade runs at render time rather than container startup, a change
to `.env` or the admin config form takes effect only after you re-render and
recreate the affected service:

```bash
pnpm openmapx compose render
pnpm openmapx services recreate valhalla
```

The admin panel's **Save & Apply (restart)** button does the equivalent in one
click. For the broader picture of what goes in `.env` and how the admin panel
fits in, see [Configuration](./configuration.md).

:::note Data-manager credentials are separate
The POI ingest pipeline runs inside the `data-manager` container, which can't
see the integration host's config cascade. Sources that need API keys (certain
parking and transit feeds) read them from data-manager environment variables set
directly in `infra/docker/.env`, not from the admin UI.
:::

## Exposure: what's reachable from outside

By default every service is reachable **only** on the private `openmapx` Docker
network — other containers reach it by service id (`http://valhalla:8002`,
`http://nominatim:8080`). Nothing is exposed to the host or the internet unless
its manifest opts in, in one of two ways:

- **Traefik routing** (`exposure.proxy`) — the common case for HTTP services.
  The renderer attaches Traefik labels so requests for a path prefix under your
  domain route to the container. TileServer GL, for example, is served at
  `https://${DOMAIN}/tiles/`.
- **Host port binding** (`exposure.hostPorts`) — publishes a container port on
  the host. These default to binding `127.0.0.1` (loopback only), so a port is
  reachable from the host itself but not the public internet unless the manifest
  deliberately binds a non-loopback address.

The practical takeaway for an operator: putting a service in the selection makes
it available to the rest of the stack, not to the outside world. Public reach is
a property of the manifest, and the admin install preview flags any community
service that requests a non-loopback host port as **publicly accessible** before
you confirm. The exposure fields themselves are documented in the Developer
section's service-manifest reference.

## Where to go next

- **[Getting started](./getting-started.md)** — the first-deployment walkthrough
  that ties these commands together.
- **[Preparing data](./preparing-data.md)** — downloading OSM, GTFS, and styles,
  and the build/link pipeline.
- **[Configuration](./configuration.md)** — `.env`, secrets, and the admin
  panel.
- **[Upgrading](./upgrading.md)** — pulling new images and re-rendering safely.
