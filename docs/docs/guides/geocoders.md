---
title: Self-hosting geocoders
description: Prepare Photon, Nominatim, or Pelias and configure the geocoding provider chain.
sidebar_position: 2
---

# Self-hosting geocoders

Choose a local engine for name/address search, then configure its companion
integration in OpenMapX. Complete [Getting started](../install/getting-started.md)
first; the commands below assume a healthy core stack and data-manager.

Photon, Nominatim, and Pelias overlap. Start with the engine that meets your
coverage and query needs, rather than importing all three. See
[Search and autocomplete](../features/search.md) for user behavior.

## Choosing an engine

|                           | **Photon**                          | **Nominatim**                     | **Pelias**                                                               |
| ------------------------- | ----------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Best at                   | Search-as-you-type                  | Completeness, reverse, enrichment | Composite/modular geocoding                                              |
| Setup                     | One container                       | One container                     | Four containers                                                          |
| Getting data              | Auto-downloads a prebuilt index     | Imports OSM on first boot         | Multi-step build pipeline                                                |
| Build step                | None                                | None (self-imports)               | `openmapx services build pelias`                                         |
| Memory ceiling (manifest) | 8 GiB                               | 64 GiB                            | 4 GiB Elasticsearch; other runtime services have no fixed manifest limit |
| Disk (planet)             | dataset-dependent                   | dataset-dependent                 | dataset-dependent                                                        |
| Reverse geocoding         | Yes                                 | Yes (also powers enrichment)      | Yes                                                                      |
| Updates                   | Re-downloads the index periodically | Built-in OSM replication          | Re-import                                                                |
| Public fallback           | Komoot's instance                   | The OSM instance                  | No public hosted default                                                 |

Manifest memory limits are ceilings, not measured RAM requirements. Dataset
size, import workspace, refresh strategy, and source density determine capacity.
The repository does not establish fixed planet database sizes or import times;
plan and measure the selected dataset before an unattended import.

## Pointing the app at your geocoder

Configure the provider in the admin panel after preparing the service:

1. Enable the matching provider integration. Each engine has a companion
   `geocoding-*` integration that adapts its API to the OpenMapX result
   shape: `geocoding-photon`, `geocoding-nominatim`, `geocoding-pelias`.
2. Put the provider in the chain. The `geocoding` integration takes a
   comma-separated **provider order** (config key `provider`), the fallback
   chain tried left to right. The default is `maptiler`; set it to your engine,
   for example `photon` or `photon,maptiler`.

Each provider integration also has an `endpoint` config value. When you run the
self-hosted service, you can leave it blank: the orchestrator resolves the
endpoint from the running service automatically (via the `geocoder` capability).
Set it explicitly only to point at an instance elsewhere, or to override the
public default. These adapters resolve the selected local service first, then `endpoint` from
integration config, then the built-in fallback (Komoot for Photon, the OSM
instance for Nominatim, or development loopback for Pelias). Within integration
config, `INTEGRATION_GEOCODING_<NAME>_ENDPOINT` wins over the admin value. It does
not override a selected local service. To use an external instance, remove the
matching local service from the selection and recreate `app-api`.

Geocoding calls are proxied through the API server. The upstream receives the
query and server address; review its request-data handling before using it.

### Geocoders and code catalogs are separate

The geocoder handles ordinary names, addresses, and reverse lookups. Specialist
airport/transit codes and OSM references also use `search-suggestions`. Changing
the general provider chain does not replace those catalogs. See
[Search and autocomplete](../features/search.md) and the
[Entur guide](../developer/entur-geocoder.md) for regional provider configuration.

:::caution[Public endpoints have separate usage policies]
A built-in fallback URL is not permission to send unrestricted traffic. In
particular, the [public Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
limits an application's aggregate load to at most one request per second and
forbids autocomplete. Use a local or contracted provider for autocomplete and
higher volume. Retain attribution and review the policy of every hosted fallback.
:::

## Photon

Photon downloads a prebuilt index derived from Nominatim data. It consumes no
source data from data-manager and has no CLI build step.

Enable and start:

```bash
pnpm openmapx services enable photon
pnpm openmapx services start photon
```

On first boot the container downloads the selected index (`planet` by default) into its
bind-mounted data directory (`data/photon/`) and stays in Docker's `starting`
state until it's ready. Allow time for both download and extraction; index size and bandwidth vary. Watch it:

```bash
pnpm openmapx services logs photon --follow
```

Subsequent starts reuse the cached index.

By default Photon pulls the full planet index regardless of
region. To download a smaller country index instead, set `PHOTON_REGION` (a
region supported by the upstream index provider, such as `germany`) in `infra/docker/.env`, then re-render and apply:

```bash
# infra/docker/.env
PHOTON_REGION=germany
```

```bash
pnpm openmapx compose render
pnpm openmapx services start photon
```

The container has an 8 GiB memory ceiling. Measure use for your index and query
volume, and budget refresh workspace. See the Photon row in [Requirements](../install/requirements.md).
The index is refreshed automatically on a long interval (`UPDATE_INTERVAL`,
720 hours/30 days by default) using the `PARALLEL` strategy. It downloads the new
index alongside the old one and replaces it when ready. Monitor failures and
index age; scheduled refresh does not guarantee freshness. For disk sizing, a `PARALLEL` refresh briefly needs room
for two copies of the index, so size the volume for roughly double the planet
footprint if you let updates run unattended.

Enable the `geocoding-photon` integration and put `photon` in the
provider order. Leave the integration's endpoint blank and it resolves to your
running service; with no service, it falls back to Komoot's public instance.

## Nominatim

Nominatim bundles its own PostgreSQL and imports an OpenStreetMap extract on
first start. There is no separate CLI build command.

Nominatim _consumes_ an `osm-pbf`, so download the
extract and link it into place before starting:

```bash
pnpm openmapx data download osm europe/germany   # or "planet" for worldwide
pnpm openmapx services enable nominatim
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start nominatim
```

The link step supplies `data.osm.pbf` under the container's input mount. The
first start imports that extract into Nominatim's database. A large import can
outlast the ten-minute health-check startup grace. Follow the logs and query
readiness instead of treating grace expiry as proof of failure:

```bash
pnpm openmapx services logs nominatim --follow
```

The manifest sets a 64 GiB memory ceiling. This is not a measured import peak
or a promise that any country or planet import fits. Include database, flat-node,
input, and temporary storage in the capacity budget. A few import knobs live in `infra/docker/.env`:

```bash
# infra/docker/.env
NOMINATIM_THREADS=8                 # import parallelism
NOMINATIM_IMPORT_WIKIPEDIA=true     # importance ranking from Wikipedia
```

The manifest currently fixes `IMPORT_STYLE=full`, `REVERSE_ONLY=false`, and a
planet daily replication URL in the container environment. These fields are not
exposed in a service configuration schema; inventing a `SERVICE_NOMINATIM_*`
override does not change them. For a regional deployment, review replication
compatibility and growth before leaving updates unattended. A custom replication
configuration is host maintenance beyond the currently exposed controls; see
[Nominatim replication settings](https://nominatim.org/release-docs/latest/customize/Settings/#replication-update-settings).

Enable `geocoding-nominatim` and put `nominatim` in the provider
order. A blank endpoint resolves to your service, falling back to the public OSM
instance. Because Nominatim also powers reverse geocoding and place enrichment
elsewhere in the stack, test both search and enrichment when changing its endpoint.

## Pelias

Pelias is a composite geocoder: a query API in front of Elasticsearch, fed by
both OpenStreetMap (addresses, venues, streets) and Who's On First
(administrative boundaries). Its API supports structured and
autocomplete queries and runs as **four
services**: `pelias` (the API), `elasticsearch`, `pelias-placeholder`, and
`pelias-pip`. The `pelias` preset bundles them.

Pelias has no public hosted fallback in this configuration. Run it locally or
configure an external instance you operate or contract for.

Download the OSM extract, then run the
Pelias build, which stages the PBF, downloads Who's On First, imports both into a
temporary Elasticsearch node, and builds the Placeholder database:

```bash
pnpm openmapx data download osm europe/germany   # or "planet"
pnpm openmapx services enable pelias
pnpm openmapx services build pelias --region europe/germany
```

The build writes its prepared data under `data/pelias/` (the OSM PBF, Who's On
First bundles, and the Placeholder SQLite store). It runs in an isolated,
temporary Compose project and tears that down when finished. The build must
not run while the runtime Pelias services are up. If they are, stop them first.

:::caution[Stop the consumers before rebuilding]
The build creates a replacement data tree and Elasticsearch index. It refuses
to run while `pelias`, `pelias-placeholder`, `pelias-pip`, **or `elasticsearch`**
is running. Stop the whole Pelias stack before rebuilding; the previous index
is kept on build failure, but consumers remain stopped until you start them. See [Preparing data](../install/preparing-data.md) for why builds and
live consumers don't mix.
:::

Start the runtime services:

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start --preset pelias
```

The link step wires the Placeholder and PIP services to the data the build
produced; `data link` is what connects each consumer to its producer directory.
Elasticsearch must come up healthy before the API will serve; its manifest
declares that dependency, so the renderer orders startup for you.

Elasticsearch has a 4 GiB memory ceiling; the other runtime
containers and temporary build node need additional resources. The old and new
index coexist during preparation. See the Elasticsearch (Pelias backend) row in
[Requirements](../install/requirements.md). The managed refresh
re-runs the build against a newer extract.

Enable `geocoding-pelias` and put `pelias` in the provider order.
Leave `endpoint` unset for the selected local service. For an external Pelias,
set the URL reachable from `app-api`; there is no public hosted Pelias fallback.

:::tip[Elasticsearch needs a kernel setting]
Elasticsearch refuses to start unless the host's `vm.max_map_count` is at least
`262144`. Set it on the Docker host with
`sudo sysctl -w vm.max_map_count=262144` (persist it in `/etc/sysctl.conf`).
:::

## Verifying

Once an engine is running, confirm the chain answers from it by searching in the
app and inspect the attribution beneath suggestions to identify the provider.
You can also check container health directly:

```bash
pnpm openmapx services status photon       # or another single service ID
pnpm openmapx check                        # one-shot status across the stack
```

To rule the orchestrator out and confirm the engine itself is serving, query its
host port directly. Each engine's port is the one its `service.json` binds to
`127.0.0.1`, so these commands run on the Docker host. Pick the
block for the engine you're running:

```bash
# Nominatim (host port 8088). Check status and a query in loaded coverage.
curl --fail --silent --show-error http://localhost:8088/status
curl --fail --silent --show-error 'http://localhost:8088/search?q=Berlin&format=jsonv2' | jq '.[0].display_name'
```

```bash
# Photon (host port 2322). This is also its container health probe.
curl --fail --silent --show-error 'http://localhost:2322/api?q=Berlin' | jq '.features[0].properties.name'
```

```bash
# Pelias — note the API is on host port 4300 (container 4000). Check the
# backend first: Elasticsearch must be green/yellow before the API will serve.
curl --fail --silent --show-error http://localhost:9200/_cluster/health | jq '.status'
curl --fail --silent --show-error 'http://localhost:4300/v1/search?text=Berlin&size=1' | jq '.features[0].properties.label'
```

An empty result can mean absent coverage, valid absence, or incomplete
preparation. Inspect the selected region and logs; zero results alone do not
prove an import failure. A red Elasticsearch `status` means it never came up healthy; check
`vm.max_map_count` and disk space first (see the Pelias notes above).

## Switching

To switch engines, prepare and verify the replacement, enable its integration,
and change the provider order. Provider data stores are separate. With no
geocoder configured at all, the map, coordinate input, and Plus Codes still work;
you simply lose name and address suggestions until a provider is back in the
chain.

## Where to go next

- [Search & autocomplete](../features/search.md): how the provider chain,
  caching, and result shaping behave in the app.
- [Requirements](../install/requirements.md): the RAM and disk each engine
  needs, by region scale.
- [Managing services](../install/managing-services.md): the full vocabulary
  of `enable`, `render`, `start`, `build`, and `configure`.
- [Preparing data](../install/preparing-data.md): downloading OSM extracts
  and the build/link pipeline these engines feed on.
- [Service manifests](../developer/service-manifest.md): the schema behind
  every `service.json` referenced here.
