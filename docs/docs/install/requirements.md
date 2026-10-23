---
title: Requirements
description: Host tools, deployment boundaries, and capacity planning for OpenMapX.
sidebar_position: 1
---

# Requirements

OpenMapX runs a generated Docker Compose stack from a repository checkout. Start
with the default application services and add routing, geocoding, transit, and
tile services as needed. Each engine adds its own data preparation and storage
requirements.

## Software prerequisites

| Software       | Requirement                                                         |
| -------------- | ------------------------------------------------------------------- |
| Docker Engine  | A current supported release with access to the local Docker socket  |
| Docker Compose | Compose v2 (`docker compose`)                                       |
| Node.js        | `>=24.22.1`, as declared in the root `package.json`                 |
| pnpm           | The version in the root `packageManager` field, currently `12.11.2` |
| Git            | Needed for the checkout and community service repositories          |
| OpenSSL        | Used in the setup examples to generate random secrets               |

Install the locked workspace dependencies with `pnpm install --frozen-lockfile`.
Run the CLI as `pnpm openmapx <command>` from the repository root. It loads
`infra/docker/.env`; existing shell variables take precedence.

Docker helper images provide the OSM conversion and engine build tools. You do
not need to install `osmium` on the host. Artifact export and import use host
`tar`; streaming to another host also needs SSH. Diagnostic examples use `curl`
and, where shown, `jq`.

### Operating system

Use a 64-bit Linux host for the managed deployment. The ops-agent needs a local
Docker socket, a writable checkout mounted at the same absolute host path, and
Unix file ownership and permissions. A remote Docker context, Kubernetes, or a
split-host deployment is not the managed Compose workflow described here.

Docker Desktop can be useful for exploration, but check image support for the
host architecture and allocate memory and disk to its Linux VM. Do not assume
that successful local startup establishes production readiness on Linux.

Run the checkout and containers under compatible IDs (`UID` and `GID`, default
`1000:1000`). The ops-agent rejects writable-by-others trusted manifests and
directories. Clone and update with `umask 022`. The container user also needs to
read the registry credentials directory if private images are used.

## Hardware

Size for the services that run together, including temporary build containers.
Container memory limits are ceilings, not measured usage, minimum RAM, or a
promise that an import will fit. A regional extract can still need substantial
memory, depending on its density and the enabled features.

### Baseline: the core app

The default roots are `traefik`, `well-known`, `app-api`, `app-web`, `postgis`,
`redis`, and `data-manager`. Their dependencies also select `ops-agent` and
`transitous-runner`. The current memory limits add up to about 18 GiB, principally
because data-manager has an 8 GiB limit and transitous-runner has a 4 GiB limit.
Idle use can be lower. These limits do not establish a tested 4 GiB deployment.

Hosted backends can reduce local engine costs. They still need appropriate
credentials, permitted usage, connectivity, and a review of which requests leave
your infrastructure. See [Cost optimization](../guides/cost-optimization.md).

### Engine sizing

Current defaults in `services/<id>/service.json`:

| Service or bundle | Container memory ceiling | Capacity considerations                                              |
| ----------------- | ------------------------ | -------------------------------------------------------------------- |
| Nominatim         | 64 GiB                   | Initial OSM import, database, flat-node storage, and replication     |
| Overpass          | 32 GiB                   | Converted OSM input, database, and update working space              |
| Valhalla          | 16 GiB                   | Routing tiles, elevation, administrative and time-zone data          |
| MOTIS             | 16 GiB **per slot**      | Active and candidate imports, rollback generations, feed-proxy cache |
| OTP               | 16 GiB runtime           | Separate build helper defaults to a 24 GiB Java heap                 |
| Photon            | 8 GiB                    | Prebuilt index; parallel refresh needs old and new indexes together  |
| OSRM              | 8 GiB runtime            | Extract, graph, and preprocessing working files                      |
| Local AI          | 8 GiB                    | Model files and model-dependent inference memory                     |
| Elasticsearch     | 4 GiB                    | Pelias also needs its API, Placeholder, PIP, and build workspace     |
| BRouter           | 2 GiB                    | Selected `.rd5` segments plus a replacement generation               |
| TileServer GL     | 2 GiB runtime            | Separate Planetiler build, MBTiles, glyphs, and temporary files      |
| Managed Dawarich  | 8.5 GiB total            | App 4 GiB, worker 2 GiB, database 2 GiB, queue 512 MiB               |

Pelias API, Placeholder, PIP, and Martin do not all have fixed manifest memory
limits. Include them in the host budget. See the individual
[guides](../guides/supporting-infrastructure.md) for preparation and diagnostics.

OSRM and OTP preparation refuse `planet` input. MOTIS planet operation is
experimental and requires an explicit profile and capacity confirmation; its
regional 16 GiB slot limit is not a worldwide sizing recommendation. See
[MOTIS operations profiles](../administration/motis-operations-profiles.md).

### Sizing by geographic scale

Choose the smallest region covering the routes and searches you need. Before
starting a large import, allow space for:

- raw downloads and secondary formats, such as Overpass's OSM XML bzip2 input;
- active indexes and complete staged replacements;
- build work directories and retained rollback generations;
- database growth, attachments, logs, and local backups;
- independent off-host backups of state you cannot regenerate.

Use SSD or NVMe storage with Unix permissions. A planet dataset can require
hundreds of gigabytes per engine and much more during preparation. Disk use
changes with upstream datasets and build settings; the repository does not
provide a measured country/continent/planet hardware guarantee.

Start heavy initial imports one at a time. MOTIS refresh is an exception to a
single-engine budget: the active engine and its staging candidate can coexist.
Build helpers can also exceed the runtime container's memory limit.

:::caution[Keep shared data on one filesystem]
Hardlinks work only within one filesystem. Keep the producer and consumer paths
under `infra/docker/data/` on the same filesystem. Hardlinks save duplicate input
bytes; they do not reduce the space required for derived indexes or replacement
builds.
:::

## What the operator must provide

Copy `infra/docker/.env.example` to `infra/docker/.env` and configure:

- a public `DOMAIN` and `ACME_EMAIL`, with DNS and inbound TCP 80/443 reaching
  Traefik; publish an AAAA record only if IPv6 works end to end;
- unique `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `OPENMAPX_SECRETS_KEY`,
  `DATA_MANAGER_AUTH_TOKEN`, and `OPENMAPX_LOCAL_ADMIN_TOKEN` values;
- `OPENMAPX_HOST_DIR` as the absolute checkout path and `DOCKER_GID` as the local
  Docker socket's group ID;
- explicit `TRANSITOUS_COUNTRIES` or a MOTIS feed allow-list for the default
  regional profile, even if you do not enable a transit engine.

The renderer creates additional files in `infra/docker/secrets/`. Protect these
and the deployment configuration separately from ordinary volume backups.
Per-integration provider credentials are usually configured after startup in
the admin panel. An external endpoint being configured does not establish that
its terms permit your workload.

## Where to go next

Follow [Getting started](./getting-started.md) for the first deployment, then
[Managing services](./managing-services.md) and [Preparing data](./preparing-data.md)
for optional engines.
