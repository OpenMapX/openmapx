---
title: Self-hosting OSM queries (Overpass)
description: Prepare an Overpass database, choose regional replication, and verify OpenStreetMap queries.
sidebar_position: 4
---

# Self-hosting OSM data queries

Overpass answers OpenStreetMap tag and geometry queries for category search,
nearby transit features, and cycling, hiking, and nautical overlays. A local
instance reduces reliance on shared public query servers, but needs its own
import, replication, storage, and capacity management.

Complete [Getting started](../install/getting-started.md) first. The examples
assume a healthy data-manager, local Docker access, and enough disk for the PBF,
converted input, and database.

## What Overpass is

Overpass keeps an OSM database and answers Overpass QL queries, such as cafés in
a bounding box or hiking relations. It serves data rather than routing graphs
or rendered tiles. A self-hosted instance has finite query resources too;
removing public-server quotas does not make expensive queries unrestricted.

Without a local endpoint, configured integrations can use public Overpass
services. Review the relevant server's usage policy and availability before
relying on it for application traffic. A local Overpass covers only the area
and data timestamp you imported and maintained.

## What it powers

| Feature                 | Integration        |
| ----------------------- | ------------------ |
| POI/category search     | `poi-overpass`     |
| Nearby transit features | `transit-overpass` |
| Cycling overlay         | `overlay-cycling`  |
| Hiking overlay          | `overlay-hiking`   |
| Nautical overlay        | `overlay-nautical` |

Selecting `overpass` lets the deployment route the applicable server-side calls
to `http://overpass:80`. Explicit helper or integration endpoint settings can
have their own resolution behavior. Recreate API after changing its environment
or applied service selection, then test the actual feature.

## Enabling Overpass

```bash
pnpm openmapx services enable overpass
```

Prepare the data and replication settings below before starting. The image has
no separate CLI build hook; it imports on first startup with `OVERPASS_MODE=init`.
The manifest gives its health check a two-day startup grace. That is a bounded
grace period, not a guarantee every import will finish within it.

## Preparing the data

For Germany:

```bash
pnpm openmapx data download osm europe/germany
pnpm openmapx data convert overpass europe/germany
```

Conversion writes bzip2-compressed OSM XML to
`infra/docker/data/osm-bz2/data.osm.bz2`. `OVERPASS_REGION` or `OPENMAPX_REGION`
can supply the omitted positional region. This conversion is separate from
`data update` and must be repeated when replacing the source PBF.

Set the replication URL for the imported extract in `.env`:

```dotenv
OVERPASS_DIFF_URL=https://download.geofabrik.de/europe/germany-updates/
```

The manifest's default is the **planet** daily replication feed. Do not apply it
unexamined to a regional database: it can pull changes from outside the intended
scope. Use a feed compatible with the extract and its replication state.

Then link and start:

```bash
pnpm openmapx data link
pnpm openmapx services start overpass
pnpm openmapx services start app-api
pnpm openmapx services logs overpass --follow
```

The converted input is mounted read-only at `/osm`; the live database is a
writable bind mount at `infra/docker/data/overpass/db`. Initial import can take
hours or longer. Wait for completion and query-level checks before directing
production workload to it.

## Resource cost

The manifest's container memory ceiling is 32 GiB. Database size and import time
vary with region, metadata, areas, and replication. There is no measured
country/continent/planet capacity guarantee in the manifest. Use SSD storage,
reserve import headroom, and monitor actual growth.

`OVERPASS_SPACE` is the dispatcher's available **RAM budget in bytes**, not a
database disk-size limit. The manifest default is `107374182400` (100 GiB),
which exceeds the 32 GiB container ceiling. Set a budget that fits your container
and leaves room for the database processes and workers; raising it does not
allocate more host memory. See the
[image's configuration reference](https://github.com/wiktorn/Overpass-API#configuration).

`OVERPASS_FASTCGI_PROCESSES` defaults to `4`. More workers can increase concurrent
memory and CPU pressure. The manifest sets a 300-second maximum FastCGI timeout.
Apply `.env` changes with `pnpm openmapx services start overpass`; an in-place
restart does not reload the environment.

## Verifying it works

Host loopback port `8082` maps to internal port 80. Use encoded query data so
curl does not interpret Overpass brackets as URL globbing:

```bash
curl --fail --silent --show-error --get \
  --data-urlencode 'data=[out:json];node(1);out;' \
  http://localhost:8082/api/interpreter
```

That confirms the interpreter answers, but node 1 may be outside your extract.
Query a known populated area in your coverage:

```bash
curl --fail --silent --show-error --get \
  --data-urlencode 'data=[out:json];node[amenity=cafe](52.5,13.3,52.6,13.5);out;' \
  http://localhost:8082/api/interpreter | jq '.elements | length'
curl --fail --silent --show-error http://localhost:8082/api/status
```

Replace Berlin's bounds if needed. An empty result can indicate missing coverage,
valid absence, incomplete import, or a failed query; inspect logs and replication
state. The interpreter response includes the OSM base timestamp. `/api/status`
reports dispatcher/load information and is not a substitute for checking data age.

For a deliberate fresh import, stop queries first and keep the previous database
until the replacement is verified. With enough disk for both and no existing
`db.before-reimport` directory:

```bash
pnpm openmapx services stop overpass
mv infra/docker/data/overpass/db infra/docker/data/overpass/db.before-reimport
mkdir -p infra/docker/data/overpass/db
pnpm openmapx data download osm europe/germany
pnpm openmapx data convert overpass europe/germany
pnpm openmapx data link
pnpm openmapx services start overpass
```

Confirm replication settings still match. If the new import fails, stop Overpass
and restore the saved directory under the original path before restarting. Do
not delete either database while its container is running. Remove the saved copy
only after query and update checks pass and the recovery window is complete.

## Where to go next

See [Map layers and overlays](../features/map-layers.md),
[Preparing data](../install/preparing-data.md), and
[Cost optimization](./cost-optimization.md) for related workloads.
