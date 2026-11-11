---
impacts: [breaking, migration, operator-action]
---

## What changes

The Docker Compose project is named `openmapx` instead of `docker`. Compose
prefixes every container, network and named volume with the project name, so
they are all renamed: containers such as `docker-valhalla-1` become
`openmapx-valhalla-1`, the stack network `docker_openmapx` becomes
`openmapx_openmapx`, and volumes such as `docker_openmapx-pgdata` become
`openmapx_openmapx-pgdata`. `pnpm redis:flush`, `pnpm openmapx check` and the
default `VALHALLA_CONTAINER` follow the new name.

An existing stack's volumes are not adopted. The renamed stack starts with
empty databases and state, and the old `docker_*` volumes stay on the host
unused.

## Who is affected

Every Docker deployment that updates to this release. It is meant for a fresh
install. An existing installation must not update past the previous release.

Hosts that run another Compose project on the stack's proxy network, such as
the documentation host from `docs/deploy/docker-compose.yml`, are affected too:
the network they join is renamed.

## Required action

Install fresh from this release with an empty `infra/docker/state`. Do not
expect data from an earlier installation's volumes to appear.

Point the documentation host at the new network: set the external network name
and the `traefik.docker.network` label in its compose file to
`openmapx_openmapx`, then redeploy it. Any other stack that joins the old
`docker_openmapx` network needs the same change.

Remove the old `docker_*` volumes only once nothing needs them; the release
does not delete them.
