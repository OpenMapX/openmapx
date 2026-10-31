---
impacts: [migration, operator-action]
---

## What changes

Administrators can manage services, supported platform settings, transit data,
prepared artifacts, integrations, account policy, backups and privacy workflows
through the panel. Mutations retain their original jobs and recovery inputs
across lost responses and process restarts. Uncertain operations keep their
writer fences until their original outcomes can be verified.

The API migrations add account-policy, integration ownership, artifact-transfer
and privacy-workflow storage alongside durable execution records. Existing auth
settings are activated explicitly through the account-policy workflow.

## Who is affected

Self-hosted installations upgrading the API, web application, CLI, Data Manager
and operations agent, and authors of community service manifests.

## Required action

Apply the normal API database migrations and upgrade the control services
together. Preserve existing installation keys, pending jobs and recovery
records. Inspect Activity before retrying an uncertain mutation; deleting its
records does not prove that its host effect stopped.

Before the first render, make the host-control authority ancestors
non-group-writable with `chmod go-w . infra infra/docker infra/docker/secrets`
from the checkout root. Existing unsafe directories are refused rather than
silently repaired. See the installation and upgrade guides for host-owned
overrides and recovery boundaries.

New prepared-data directories and metadata use explicit safe creation modes.
If an existing dataset is reported as unsafe, verify its ownership and remove
group/other write permissions from the reported paths before retrying. The
panel does not silently change ownership or repair existing dataset permissions.

Community service configuration schemas must not declare the reserved platform
resource names `OPENMAPX_MEMORY_MIB`, `OPENMAPX_CPU_LIMIT` or
`OPENMAPX_JAVA_HEAP_MIB`.
