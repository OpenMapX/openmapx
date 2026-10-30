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
`redis`, `data-manager`, and `ops-agent` — is selected by default; everything heavy
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
Effective: traefik, well-known, app-api, app-web, postgis, redis, data-manager, ops-agent, valhalla, photon
```

The selection is resolved from the first source that's present, in this order:

1. an explicit `--services` flag on `compose render` / `compose up`
2. the `OPENMAPX_ENABLED_SERVICES` environment variable
3. `infra/docker/service-selection.json`
4. the built-in core defaults

When `OPENMAPX_ENABLED_SERVICES` is set, `enable` and `disable` refuse to edit
the file — the environment variable is the source of truth in that case, and the
CLI keeps it unambiguous.

The admin panel works on the same selection: **Save Selection** writes
`infra/docker/service-selection.json` too, and its Services page shows the
selection exactly as `services selected` does.

:::note[Selection is not the same as running]
Editing the selection changes what _will_ be rendered and started. It does not
touch running containers. Enabling a service is followed by a render and a start
(below) before it actually comes up.
:::

### Presets

A **preset** is a named bundle of root services, so you can say "start the
routing stack" instead of listing every id. Presets work on `services start`,
`stop`, `restart`, `update`, and on `compose render` / `compose up`:

| Preset      | Services                                                      |
| ----------- | ------------------------------------------------------------- |
| `app`       | `app-api`, `app-web`, `well-known`                            |
| `proxy`     | `traefik`                                                     |
| `dev`       | `postgis`, `redis`                                            |
| `routing`   | `osrm`, `valhalla`                                            |
| `transit`   | `motis`, `motis-feed-proxy`, `otp`                            |
| `pelias`    | `pelias`, `pelias-pip`, `pelias-placeholder`, `elasticsearch` |
| `nominatim` | `nominatim`                                                   |
| `photon`    | `photon`                                                      |
| `overpass`  | `overpass`                                                    |
| `tiles`     | `tileserver`                                                  |
| `martin`    | `martin`                                                      |

Services that are not grouped into a preset — including `data-manager`,
`ops-agent`, `local-ai`, `dawarich-app`, `dawarich-postgis`, `dawarich-redis`,
`dawarich-sidekiq`, `transitous-runner`, and `motis-staging` — are targeted
directly by service id.

Presets compose, and they mix freely with explicit ids:

```bash
pnpm openmapx services start --preset app,proxy,dev
pnpm openmapx services start postgis --preset routing
```

## Rendering the stack

OpenMapX has no hand-maintained compose file. The renderer reads the enabled
manifests and applies the stack:

```bash
pnpm openmapx compose render
```

Each render writes a **configuration generation** under
`infra/docker/.trusted-config-generations/` and points
`infra/docker/.trusted-config-current` at it. A generation holds:

- `docker-compose.generated.yml` — the compose file of the stack
- `docker-compose.generated.hardlinks.json` — the plan that maps each consumer
  to its data producer (applied later by `openmapx data link`)
- the selection it was rendered from, and the service settings and vault
  credentials saved in the admin panel

The admin panel's **Apply changes** writes the same kind of generation, so the
CLI and the admin panel always run the same stack. A CLI render keeps what was
saved in the admin panel: it cannot read the database, so it takes those
settings and credentials from the current generation. Settings in `.env`
(`SERVICE_<ID>_<KEY>`) win over them in both.

The stack is addressed as Compose project `docker` with `infra/docker/.env` as
its environment. To run Compose by hand, name both:

```bash
docker compose --env-file infra/docker/.env \
  -f infra/docker/.trusted-config-current/docker-compose.generated.yml ps
```

Render is deterministic — same manifests, `.env` and saved settings in, same
generation out — so it's cheap to re-run. Re-render any time the manifests, your
`.env`, the selection, or the registered community repos change. You can
override the selection or domain for a single render without touching the
persisted selection:

```bash
pnpm openmapx compose render --services valhalla,photon
pnpm openmapx compose render --preset routing
pnpm openmapx compose render --domain maps.example.com
```

`--domain` defaults to `DOMAIN` from `infra/docker/.env`, so you rarely need it.

The admin panel's Compose page also offers revision-checked **Generate
configuration** without container lifecycle effects. Nonempty hardlink plans need
an already-running Data Manager. **Compose Up** preserves Data Manager and the
executing agent; use their guarded Apply/Update or Settings/Maintenance workflows
to replace them. Full shutdown uses the host command below because it removes the
web control plane:

```bash
pnpm openmapx compose down
```

This retains volumes. Only add `--volumes` when intentionally destroying the
stack's volumes after reviewing backups. If the agent cannot start, repair the
host deployment before attempting further UI operations.

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
pnpm openmapx services update valhalla                 # pull images + replace container
pnpm openmapx services status                          # container table (all services)
pnpm openmapx services status valhalla                 # one service
pnpm openmapx compose pull [ids...]                    # pull images without starting containers
pnpm openmapx compose release                          # update release pin against release manifest
pnpm openmapx compose rotate-redis-password --confirm-clients-stopped # rotate Redis ACL/secret
```

The distinction between `restart` and `start`/`update` matters:

- **`restart`** reboots the container in place. It does not re-render, so it
  won't pick up a changed manifest, `.env`, or selection — use it to bounce a
  service whose image and config are unchanged.
- **`start`** re-renders first, so it picks up compose-file changes.
- **`update`** re-renders, pulls the latest images, and replaces the container — the
  command to reach for after a `git pull` that bumps image tags.
- **`compose rotate-redis-password`** atomically rotates Redis credentials while
  Redis clients (`app-api`, `data-manager`) are stopped, updating both secret files
  and Redis ACL configuration safely.

The PostGIS entrypoint forwards the first stop signal to PostgreSQL and waits
for it to exit, preserving its exit status. Docker allows the declared five-minute
shutdown grace before forcing termination. A stop during startup cancels readiness
or password synchronization without marking the database healthy. This container
grace is separate from the deadline of the service-management request.

For a single one-off check of the running containers across the stack:

```bash
pnpm openmapx check
```

You can also audit declared capabilities across installed service manifests:

```bash
pnpm openmapx services capabilities
pnpm openmapx services capabilities --unrecognised
```

MOTIS dataset promotion must remain disabled while upgrading until both
`ops-agent` and `data-manager` support confirmed primary and staging stops.
Updating only the agent is insufficient: older data-managers suppress stop
failures. A new data-manager connected to an older agent rejects stop results
without a confirmed `stopped` or `absent` state and preserves the live and
candidate data. After both services are updated, a staging-stop failure requests
a restart of the old primary only when this attempt stopped it and the old data
targets are unchanged. Acknowledging that restart does not establish service
health. Recovery uses a fresh client deadline of 125 seconds, independent of job
cancellation. If the agent continues reporting pending termination, promotion
returns with recovery completion unknown and leaves both data aliases unchanged;
the agent retains ownership of its operation. Keep promotion disabled if stop
confirmation or recovery fails.

### Lifecycle operation deadlines

Lifecycle operations run through the ops-agent with a finite budget for the
whole Docker Compose command: ten minutes for stack start and service start,
stop, restart, recreate, isolated recreate, and removal. This accommodates the
built-in PostGIS five-minute shutdown grace with room for startup work. The
broker allows another thirty seconds for settlement, and the API's result wait
adds five seconds to that broker deadline; async HTTP submission timeouts remain
unchanged.

The ten-minute limit includes all stop/start work in a command, including
sequential dependency work. It does not grow with the number of services.
Longer custom shutdown graces, or a dependency chain whose aggregate work
exceeds ten minutes, are outside this guarantee and remain subject to the
bounded deadlines. The manifest duration syntax is unchanged.

Cancellation and deadline expiry terminate the Docker CLI process group, but
Docker may continue work in the daemon after the CLI exits. A timeout therefore
does not establish the final container state. Inspect the affected services
before deciding what to do next; do not automatically retry or repair the
operation.

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
extracts, GTFS feeds, map glyphs) is downloaded and refreshed separately. See
[Preparing data](./preparing-data.md) for the full data workflow, including the
one-command `data update` refresh that downloads, builds, renders, and links in
sequence.

## Configuring a service

Many services expose operator-tunable settings through a `configSchema` in their
manifest (Valhalla's elevation and admin-boundary toggles, for example). Values
resolve at render time through a three-layer cascade, highest priority first:

| Priority | Source               | Where it lives                              |
| :------: | -------------------- | ------------------------------------------- |
|    3     | Environment variable | `SERVICE_<ID>_<KEY>` in `infra/docker/.env` |
|    2     | Database             | the admin panel's per-service config form   |
|    1     | Schema default       | the manifest's `configSchema` default       |

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
apply the change to the affected service:

```bash
pnpm openmapx compose render
pnpm openmapx services update valhalla
```

The admin panel's **Save & Apply** button does the equivalent in one
click for the service it is pressed on. The two are not interchangeable,
though:

- The CLI renders without database access, so it resolves only defaults and
  `.env`, and every value saved in the admin config form falls back to its
  default in that render.
- **Save & Apply** applies the values saved in the form and recreates only
  that one service. It never reads `.env`, so a setting kept there is applied
  with the CLI. The admin panel never recreates `app-api` itself.

Pick one home per setting: keep it in `.env` as `SERVICE_<ID>_<KEY>` and apply
it with the CLI, or save it in the form and apply it with **Save & Apply**.
`app-api` and the data-manager read `.env` only when their containers are
created; after changing a variable they read, recreate them from the host with
`pnpm openmapx services start app-api data-manager`. For the broader picture of what goes in `.env` and how the admin panel
fits in, see [Configuration](./configuration.md).

:::note[Data-manager credentials are separate]
The transit pipelines run inside the `data-manager` container, which can't
see the integration host's config cascade. Feeds that need API keys read them
from data-manager environment variables set directly in `infra/docker/.env`,
not from the admin UI.
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

A loopback port that is already taken on the host can be moved from
`infra/docker/.env` with `<SERVICE>_HOST_PORT`, for example
`DATA_MANAGER_HOST_PORT=14000` or `POSTGIS_HOST_PORT=15432`. The CLI follows
`DATA_MANAGER_HOST_PORT` when it talks to the data-manager.

### Behind an existing reverse proxy

On a host where another Traefik already owns ports 80 and 443, OpenMapX can
route through it instead of starting its own. That Traefik must use the Docker
provider. Set its network, entrypoint and certificate resolver in
`infra/docker/.env`:

```bash
OPENMAPX_PROXY_NETWORK=proxy
OPENMAPX_PROXY_ENTRYPOINT=https
OPENMAPX_PROXY_CERT_RESOLVER=myresolver
```

The bundled `traefik` service is then never selected. Every routed service
(`app-web`, `app-api`, `well-known`, `tileserver`, …) joins the external
network, and its labels carry the entrypoint, resolver and network. Re-render
and start the stack as usual.

Copy `services/traefik/config/dynamic/middlewares.yml` into the external
Traefik's file-provider directory. The routes reference its middlewares with
`@file`, and Traefik disables a router whose middleware is missing. Without
`internal-deny@file`, requests to `/api/internal` fall through to the general
`/api` route and reach endpoints that are meant to be unreachable from outside.
The bundled Traefik also adds HSTS on its entrypoint. Behind your own proxy,
configure HSTS there, for example with the `hsts@file` middleware from the same
file.

Place, transit and road-condition ids travel encoded in the request path, for
example `/api/places/osm%3Anode%2F1`. Traefik 3.6.4 to 3.6.6 rejects encoded
slashes and similar characters with a 400 by default, so give the external
entrypoint the same `encodedCharacters` settings as the bundled
`services/traefik/config/traefik.yml`. Without them, opening a place or a
transit stop fails on those versions.

## Where to go next

- **[Getting started](./getting-started.md)** — the first-deployment walkthrough
  that ties these commands together.
- **[Preparing data](./preparing-data.md)** — downloading OSM, GTFS, and map glyphs,
  and the build/link pipeline.
- **[Configuration](./configuration.md)** — `.env`, secrets, and the admin
  panel.
- **[Upgrading](./upgrading.md)** — pulling new images and re-rendering safely.

## PostgreSQL workload diagnostics

API and data-manager connections carry the bounded static application names
`openmapx-api` and `openmapx-data-manager`. Inspect them in `pg_stat_activity`
without exposing connection URLs. Application names label clients;
`pg_stat_statements` aggregates statements by database, user and query identity,
not by application name. Attribute jobs with isolated replay windows or spans.

`POSTGIS_DIAGNOSTICS=false` and `POSTGIS_TRACK_IO_TIMING=false` are independent
container defaults. With both disabled the wrapper adds no diagnostic arguments.
On an initialized database, diagnostics opt-in resolves the effective
`shared_preload_libraries` with PostgreSQL's own configuration reader, preserves
its entries and adds `pg_stat_statements` once. Unresolvable or unusual quoted
preload syntax fails closed with a bounded message. Initialize the database with
diagnostics disabled first. Planning tracking stays off; I/O timing requires its
own opt-in and a separate overhead measurement.

Production activation remains deferred. Before enabling either flag, verify a
backup and restore, accept the wrapper's graceful shutdown and the ops-agent stop
deadlines together, rehearse on disposable staging, and approve a restart window.
Set the chosen flags through the usual service configuration authority, render
and recreate the service in that window. A restart alone does not apply changed
container environment. A database operator then installs the extension with
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`. Verify the settings,
extension availability, health and an actual query before returning traffic.

Collect existing counters without resetting production statistics. Use
`pg_stat_statements(false)` and select only counters and identifiers; do not expose
query text or grant public statistics access. Measure I/O timing overhead against
the same disposable workload before enabling it. Rollback restores the previous
flag values through the same authority and uses another scheduled safe restart;
it preserves prior preload entries and saved evidence. No automatic activation,
production statistics reset or shutdown acceptance is implied by these options.

The [disposable replay protocol](../developer/self-hosting-replay.md) describes
source-level comparisons and their acceptance limits.

## Optional BRouter bicycle routing

BRouter is an opt-in cycling engine. Enable and start it through the same service
selection used by the other backends:

```bash
pnpm openmapx services enable brouter
pnpm openmapx services start brouter
```

Set `SERVICE_BROUTER_REGION=europe/germany` in `infra/docker/.env` for Germany,
`europe` for Europe, another [Geofabrik extract path](https://download.geofabrik.de/),
or `planet` for worldwide coverage. `germany` is accepted as an alias. The service
configuration form exposes the same `REGION` setting. Re-render and recreate the
service after configuration changes. This setting is independent of the OSM PBF
region used by Valhalla and other services.

The service downloads prebuilt, elevation-aware `.rd5` files from
[BRouter's official segment server](https://brouter.de/brouter/segments4/),
selecting all existing 5-degree tiles overlapping the extract's bounding rectangle.
This deliberately includes neighboring areas; it is not a country-border filter.
Germany's rectangle currently needs about 1.1 GB of routing data. Planet coverage
requires substantially more disk. Downloads reserve an additional 1 GB of free
space and require enough space for a replacement generation alongside the active
one. No OSM graph build or separate elevation download is needed.

The default resource limit is 2 GB (`BROUTER_MEMORY`), with a 1 GB Java heap and
two concurrent routing calculations. The operator can configure:

- `SERVICE_BROUTER_JAVA_HEAP_MB` (default `1024`), below the container limit.
- `SERVICE_BROUTER_MAXTHREADS` (default `2`).
- `SERVICE_BROUTER_REQUEST_TIMEOUT_SECONDS` (default `30`, maximum `300`).
- `SERVICE_BROUTER_UPDATE_INTERVAL_HOURS` (default `168`, one week).

A checksum-pinned BRouter 1.7.10 release is cached in the `openmapx-brouter` named
volume and runs on the manifest's digest-pinned Java image. The JDK supplies the
ZIP extraction tool; no package installation occurs on startup. The volume holds
recreatable software and routing data and is excluded from backups.

Each refresh downloads a complete generation, checks segment lengths and lookup
versions, parses every shipped profile with the pinned engine, and publishes it
atomically. Unreferenced generations left by interrupted updates are removed
before preparing another update. The engine restarts briefly to discard old
routing caches. Failed refreshes leave the active generation untouched and retry
after one hour. A changed region must prepare successfully before it can serve;
a cached different region is never silently used. Startup health has a 30-minute
grace period for the initial download. Request-coordinate logging is suppressed.

Port `17777` is available only on the private service network and host loopback;
`BROUTER_HOST_PORT` can relocate the loopback port. No public BRouter API is used
as a fallback. The routing integration falls back to the existing Valhalla chain
when this optional engine is unavailable or cannot serve a request.

Routing data is derived from OpenStreetMap under the ODbL; the BRouter engine is
MIT-licensed. Preserve the relevant OSM and elevation-data notices when exposing
results or redistributing prepared data; the download server's current lookup
metadata and the [BRouter credits](https://brouter.de/) identify upstream sources.

When the `routing-brouter` integration is enabled, a selected BRouter service is
preferred for cycling. The route options offer touring/city, road, gravel and
mountain bikes, hill avoidance and a preference for quieter roads. These are
routing preferences; they do not guarantee traffic levels or road conditions.
Shared routes and navigation retain the selected preferences.

If BRouter is absent, unavailable or outside its prepared coverage, cycling falls
back to Valhalla. Valhalla also handles timed trips and stop optimization. Bike
preferences map to its bicycle costing options. The bundled BRouter gravel
profile cannot avoid ferries or provide a stronger general hill-avoidance level,
so gravel requests with ferry avoidance or strong hill avoidance use Valhalla. Other travel modes keep their existing engines. Operators can configure
an explicit `routing-brouter` endpoint instead of the managed service; OpenMapX
never selects a public BRouter endpoint by default.

## Move prepared data between instances

The admin panel's **Data Workflows → Prepared data** section uploads, validates,
previews and imports prepared tileserver, OSRM, OTP, Pelias and MOTIS bundles. It
also exports verified prepared data into an authenticated, temporary download.
The CLI's `data export-build` and `data import-build` commands use the same archive
validator and journaled publisher.

Use a bundle from a complete build with matching destination runtime images.
Validation checks the archive's framing, declared membership, sizes and SHA-256
hashes before publication. Archive paths, links, devices and undeclared files
cannot select host destinations. A successful upload or validation is not an
import: review the compatibility preview and explicitly confirm publication.
Imports currently support at most 10,000 payload files and directories.

Stop all consumers listed in the preview using the normal service controls.
Import never stops or starts containers, pulls images, or applies pending desired
configuration. It applies the already-current generation's hardlink plan through
the original import job; a nonempty plan requires Data Manager already running.
If files commit but the hardlink follow-up fails, keep consumers stopped and
reconcile that generation before starting them. Partial or unknown outcomes stay
visible in Activity and retain their original ownership; retrying observation does
not repeat publication.

MOTIS export requires a retained portable recipe and compiled candidate. Source
credentials and generated proxy configuration are excluded from the bundle. The
destination must have the same approved catalog pins and all required managed feed
credentials; the preview lists credential identifiers without their values. Host
credential-file overrides require explicit host preparation. Import rebuilds the
private candidate and proxy files offline from those pins and destination secrets.
Existing `live` and `staging` slot links are preserved; replaced data does not
inherit an old successful health check. Start and validate it through the normal
MOTIS workflow before treating it as ready.

Uploads stream directly, and downloads use browser-native navigation where the
client's origin and authentication permit it. Other clients require a streaming
file sink. Unsupported browsers receive guidance instead of buffering a large
archive in browser memory. Leaving the page aborts only an active byte transfer;
queued validation, import and export jobs continue in Activity. Cancel durable
work there. Deleting a stage owned by unfinished work returns a conflict.

Default agent limits are a 1 TiB upload, 2 TiB expanded archive, 4 TiB combined
stage quota, a five-minute idle timeout and a 72-hour transfer deadline. Upload
stages expire after 96 hours; prepared downloads expire after 24 hours. The
private deployment policy at `/run/openmapx/artifact-transfer-policy.json` can
adjust bounded limits and memory allocation. The UI reports the effective limits,
reservations and currently observable free space; unavailable capacity refuses
admission. Country-scale throughput depends on disk, memory, ingress and timeout
configuration and is not established by a small successful transfer.

The agent reconciles stages at startup and every 15 minutes, processing at most
1,000 per sweep. Linux descriptor locks preserve live byte owners and permit
partial-upload cleanup after actual process death. Non-Linux development hosts
retain uncertain orphan bytes for operator recovery. Expiry never releases an
unknown publication or cancels its job. Completed stage tombstones retain request
replay protection for seven days after expiry, with at most 10,000 retained
records. Failed cleanup keeps its quota charged and is retried; unknown purpose
claims remain pinned until their original evidence resolves.
