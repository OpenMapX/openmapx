---
impacts: [breaking, operator-action]
---

## What changes

Services now reach each other only by project-unique names of the form
`openmapx-<service-id>`: `openmapx-postgis`, `openmapx-redis`,
`openmapx-data-manager`, `openmapx-ops-agent`, `openmapx-api`,
`openmapx-valhalla`, `openmapx-motis`, `openmapx-motis-feed-proxy` and so on.
Every internal URL and host setting OpenMapX renders uses them, for example
`postgresql://openmapx_api@openmapx-postgis:5432/openmapx` and
`http://openmapx-data-manager:4000`. Each service, built-in or community,
answers to its name on the stack's own networks, never on the shared network of
an operator-run reverse proxy.

The reason is the reverse-proxy setup (`OPENMAPX_PROXY_NETWORK`): routed
services such as `api` and `web` also join the proxy's shared network, and
Docker can resolve a bare service name such as `redis` or `postgis` there to
another project's container, which would then receive OpenMapX's database and
Redis passwords and service tokens.

The bare names are no longer accepted where hosts are allow-listed:
`DATA_MANAGER_URL` and data-manager's `INTERNAL_API_URL` refuse plain
`http://data-manager` and `http://api`, and `OPS_AGENT_URL` accepts
`openmapx-ops-agent` but not `ops-agent`. The `rt.openmapx.local` alias of the
MOTIS feed proxy is gone; MOTIS configurations point at
`http://openmapx-motis-feed-proxy`.

Service IDs, network aliases and container names may not start with
`openmapx-`. An installed community service may not reach a built-in service
by its bare ID: inspecting or installing a repository whose service names, for
example, `postgis` or `overpass` as a host in its environment, command or
configuration defaults fails with
`Service "…" reaches built-in service "…" by its bare ID; use "openmapx-…"`.

## Who is affected

Every installation, and in particular one behind an existing reverse proxy.
Nothing is converted: a new installation starts with the new names.

## Required action

Install from empty state, as for the `api`/`web` rename. Anything you write by
hand that names an internal host must use the `openmapx-<service-id>` name: URL
and host settings in `infra/docker/.env` (`DATA_MANAGER_URL`, `OPS_AGENT_URL`,
`INTERNAL_API_URL`, `MOTIS_URL`, `OVERPASS_URL`, `TRAFFIC_VALHALLA_URL`,
`OPENCONDITIONS_URL`, `OPENCONDITIONS_CONTRIBUTIONS_URL`,
`DATA_MANAGER_PLAINTEXT_HOSTS`, …), community service settings and credentials
(for example the OpenConditions `DATABASE_URL` as
`postgresql://<role>:<password>@openmapx-postgis:5432/openmapx`,
`SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL=http://openmapx-overpass:80` and
its egress allow-list entry `openmapx-overpass`), and community manifests.
