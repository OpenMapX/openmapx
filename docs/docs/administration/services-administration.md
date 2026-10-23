---
title: Services administration
description: Select services, apply configuration, inspect logs and operate data workflows from the admin panel.
sidebar_position: 2
---

# Services administration

Use `/admin/services` with a full administrator account and an available
operations agent. The API submits typed operations to the agent; the agent owns
Docker access, registry credentials, community repositories and generated host
configuration. See [Managing services](../install/managing-services.md) for CLI
commands and deployment prerequisites.

## The service catalog

The catalog lists discovered built-in and community services, their manifest
version, quality tier, capabilities and container state. Search by name, ID or
capability, then open a service to inspect its configuration and logs.

Container state is not a functional health check. Use **Run Service Check** or
[Monitoring](./monitoring.md) when a running container does not serve requests.

### Service selection

The selection contains the requested root services and their expanded
dependencies. It is shared with `openmapx services selected` and the CLI's
`services enable` workflow.

1. Inspect the selection source and current roots.
2. Enter the required root IDs and choose **Save Selection**.
3. Review **Compose preview**, then start or update the affected services.

Saving publishes a generated configuration; it does not start or stop containers.
The selection file is `infra/docker/service-selection.json`.
A nonempty `OPENMAPX_ENABLED_SERVICES` override takes precedence and disables
editing. Empty, whitespace-only or comma-only overrides are treated as unset.

Requested selection, the published host configuration generation and running
containers can differ. Check all three after a failed apply instead of assuming
that an error restored the previous state.

### Bulk actions

Select services for **Start**, **Stop**, **Restart**, **Update** or **Build**.
Builds accept a region and a continue-on-errors option; **Build All** is
explicit. Follow the returned job in **Activity** until it reaches a terminal
state. Acceptance alone does not establish completion.

## A single service in detail

Open `/admin/services/<id>`. Its header shows container state, selection and
lifecycle actions. The detail page has **Overview**, **Configuration**, **Credentials**,
**Logs** and **Manifest** tabs.

### Overview

Review the service ID, version, author, licence, platform and source directory.
The page also shows:

| Field                 | Operator use                                           |
| --------------------- | ------------------------------------------------------ |
| Provides              | Capabilities available for integration bindings        |
| Consumes              | Shared data mounts, including optional/read-only state |
| Environment variables | Declared variables and defaults                        |
| Exposure              | Host-port bindings and declared proxy routes           |

Community services receive a separate network and no platform proxy route.
Host-port publication still creates exposure: inspect its effective bind address
and protocol in the extension preview.

### Config

Open the **Configuration** tab. A manifest's `configSchema` supplies the form. Services without one use their
documented environment or mounted configuration.

| Source     | Priority                               |
| ---------- | -------------------------------------- |
| `env`      | Highest; `SERVICE_<ID>_<KEY>` override |
| `database` | Value saved in the administration form |
| `default`  | Manifest default                       |

Environment-driven fields are disabled. Use the exact variable name shown in the
form; hyphens become underscores and names are upper-cased.

- **Save** validates and stores the patch, then publishes a full trusted host
  configuration generation. It does not recreate the container.
- **Save & apply** performs the save, then queues a service start/apply job to
  recreate the container with the generated configuration.

A host CLI render preserves settings and service secrets from the last published
configuration generation, then applies the host environment. It cannot read a
new database edit that failed before publication. If a save reports a conflict,
unknown outcome or cleanup failure, inspect current configuration and job state
before retrying. See [Configuration](../install/configuration.md).

### Credentials

Set declared secret fields here, with `OPENMAPX_SECRETS_KEY` configured for the
API vault. Values are encrypted in the database and rendered as private files;
containers receive `<KEY>_FILE=/run/secrets/<KEY>`. The API returns status and
masked values instead of the credential body.

A credential change queues an apply when host control is available. Follow that
job. A `needsRender` response requires host render/apply work; storing the
credential alone does not prove the container received it.

### Logs

Open the drawer to tail container output. Use it to diagnose startup, import or
build failures. Container logs can contain upstream diagnostics or personal data;
review and redact them before sharing.

### Manifest

Inspect the full `service.json` before changing configuration or trusting a
community service. The manifest declares intended behavior, not a security audit
of the container's executable code.

### Lifecycle actions

| Action                | Effect                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| Start / Apply changes | Render current configuration, apply hardlinks and bring the service up |
| Stop                  | Stop the service container                                             |
| Restart               | Restart in place with the existing container configuration             |

Use **Apply changes** after changing configuration, manifests or environment.
A restart does not recreate the container. Administrative host operations have
safety restrictions; use **Maintenance** for the coordinated core-release update
rather than trying to update the running API as an ordinary service job.

## Compose preview

Open `/admin/services/compose` to inspect the generated Compose YAML for the
current selection and resolved configuration. Do not edit generated files.
Use the form or source configuration, then render again.

**Compose Up** applies the enabled stack; **Compose Down** stops it. These are
stack-wide operations, so check the selection and schedule any downtime first.
On the host, `pnpm openmapx compose render` publishes a generated configuration.

## Data inventory

Open `/admin/services/data` to inspect OSM downloads, engine build directories,
transit source state and specialized publication workflows. Follow the linked
jobs for failures and progress. Operation forms, previews and risk levels come
from the API's operation catalog.

For a transit source:

1. Inspect its desired and active state, archive validation and last promotion.
2. Add an operator source with a region, safe display name, HTTPS URL,
   attribution and either an SPDX licence ID or licence URL; or select an
   existing catalog source.
3. Queue sync, enable or disable and follow its job.
4. Confirm the active source set and MOTIS promotion after the job finishes.

A failed candidate preserves the prior healthy dataset. Desired source changes
do not prove active publication. MOTIS compiles and serves static schedules;
Postgres holds source/job/validation/promotion metadata, not imported GTFS
schedule tables. See [MOTIS operations profiles](./motis-operations-profiles.md).

Other operations include OSM/glyph acquisition, full update, Overpass conversion,
hardlink sync, cleanup, Transitous key-template generation and Overture full
sync/resume. Destructive cleanup requires confirmation. See
[Preparing data](../install/preparing-data.md).

### OSM code and alias search index

Choose a downloaded region and build explicitly, or run:

```bash
pnpm openmapx data search-index build [region]
```

The job requires PostGIS and Osmium Tool. It streams into staging, builds
indexes, validates and publishes in one database transaction. Failure preserves
the prior snapshot; a newer PBF marks that snapshot stale without triggering a
large rebuild during API boot.

Inspect stage, counts, publication epoch/time and last error. A ready code/alias
index does not prove ordinary business-name/address coverage. For investigation,
record `sourceFingerprint` and `epoch` from the authenticated
`/api/data-manager/search-index/status`, plus Overture's release and region.
The summary card does not show the fingerprint. See
[Business-name/address retrieval](../developer/business-name-address-retrieval.md).

Plan disk for the PBF, staging tables/indexes and prior live schema. One active
extract or `planet` is supported, without overlapping regional unions. Derived
OSM rows stay in `osm_search` with ODbL attribution, separate from Overture.

### Nearby places publication

The **Nearby places on the map** card publishes existing OSM/Overture sources
for a custom region, Germany or the planet. Inspect active generation and source
coverage separately from staged progress. A preset does not ingest missing data.

Planet builds require a ready format-2 `planet` OSM snapshot and, when Overture
is initialized, a matching completed Overture snapshot. Interrupted candidates
can be resumed only with unchanged sources and policy, or discarded. Disable
and rollback preserve retained immutable tiles. Follow the
[publication runbook](../developer/ambient-places-publication.md) for capacity
and recovery.

### Notable places index

Inspect the Wikidata place/name counts, sitelink threshold, publication time and
last error. Data Manager builds a missing index on startup and refreshes monthly.
Choose **Rebuild now**, or run:

```bash
pnpm openmapx data notable-places build
```

The job queries SPARQL, stages and validates the result, then swaps the
`notable_places` schema transactionally. A failed refresh preserves the prior
index. Runtime depends on the endpoint and dataset; no fixed completion time is
guaranteed. See [Notable places configuration](../install/configuration.md#notable-places-for-search).

## Related admin surfaces

Use [Backups](./backup-and-restore.md) for recovery snapshots and
[Extensions](./community-extensions.md) for installing or removing community
components. Configure the features using those services under
[Integrations & bindings](./integrations-administration.md).

## Where to go next

See [Managing services](../install/managing-services.md) for CLI operations,
[Preparing data](../install/preparing-data.md) for source preparation, and
[Monitoring](./monitoring.md) for health and jobs.
