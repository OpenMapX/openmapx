---
impacts: [breaking, migration, operator-action]
---

## What changes

Administrators can manage services, supported platform settings, transit data,
prepared artifacts, integrations, account policy, backups and privacy workflows
through the panel. Accepted host operations retain their backend execution and
recovery inputs across process restarts. Keyed service, backup and maintenance
requests return the original job on an exact retry. Other legacy entrypoints
still require reviewing Activity before submitting another request. Uncertain
operations keep their writer fences until their original outcomes can be verified.

The operations agent and Data Manager collect eligible control records at startup
and every five minutes. The agent handles normal stop signals with a 30-second
shutdown window; its Compose manifest now allows 45 seconds before forced
termination. Re-render and recreate the agent to adopt that setting. Forced
crashes can still require supervised recovery; see the service-administration
runbook before clearing a stale writer guard.

The API migrations add account-policy, integration ownership, artifact-transfer
and privacy-workflow storage alongside durable execution records. Existing auth
settings are activated explicitly through the account-policy workflow.

New web and mobile sessions have a fixed maximum lifetime (168 hours by default,
or the active policy value). Activity no longer refreshes that deadline. Users
must sign in again after expiry; existing sessions keep their original expiry.
Account setup and password-reset links expire one hour after issuance.

## Who is affected

Self-hosted installations upgrading the API, web application, CLI, Data Manager
and operations agent, and authors of community service manifests.

## Required action

Apply the normal API database migrations and upgrade the control services
together. Preserve existing installation keys, pending jobs and recovery
records. Inspect Activity before retrying an uncertain mutation; deleting its
records does not prove that its host effect stopped.

Custom admin API clients must supply a caller-retained `Idempotency-Key` for
single-service actions, bulk actions and backup create/restore/delete. Reuse it
when retrying an uncertain response; use a fresh key for a deliberately new
operation. Upgrade the web client with the API.

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
