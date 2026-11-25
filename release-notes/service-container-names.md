---
impacts: [breaking, operator-action]
---

## What changes

Every service's container is named `openmapx-<service-id>`, the same name it
answers to on the stack's networks: `openmapx-postgis`, `openmapx-redis`,
`openmapx-valhalla`, `openmapx-motis`, `openmapx-dawarich-app` and so on. The
bare names `postgis`, `motis`, `motis-staging` and `motis-feed-proxy`, and
Compose's `openmapx-<service-id>-1`, are gone. A host that already runs a
container called `postgis` or `motis` no longer collides with the stack.

Service manifests no longer accept `container.containerName`, and the
data-manager setting `VALHALLA_CONTAINER` is removed. The managed Dawarich
privacy export now reaches its container, which it previously addressed as
`dawarich-app`, a name no container had.

Volume and network names are unchanged.

## Who is affected

Operators who run `docker exec`, `docker logs` or similar commands against
OpenMapX containers by name, and authors of community service manifests that
set `containerName`.

## Required action

Use `openmapx-<service-id>` in commands and scripts, for example
`docker exec -it openmapx-postgis psql -U postgres -d openmapx`. Remove
`VALHALLA_CONTAINER` from `infra/docker/.env` and `containerName` from
community service manifests.
