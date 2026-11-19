---
impacts: [operator-action]
---

## What changes

Every command and update applies hardlink plans that have links to make or prune
through one Data Manager route, `/link`: `compose up`, `data link`,
`services build`, `services start` and `services update`, `control rollback`, data
updates, artifact imports, configuration changes in the admin panel and the
administrative jobs the operations agent runs. Before, `/link` refused such a plan,
and `control rollback` and the admin panel's data link left it unapplied.

Data Manager applies the plan inside its container as a data job named by the
configuration generation. A command or update that holds a lease on its services
sends the plan under that lease, so Data Manager does not lease itself. Data
Manager first asks the operations agent whether that lease is the sender's own,
live lease on Data Manager, and refuses the plan without linking anything when it
is not or the agent does not answer. During a configuration change only that
change's own plan is applied. While another data
job or a configuration change runs, Data Manager answers busy: `compose up` warns
and starts the stack anyway, while `data link` and `services build` fail with a
message saying to retry. When Data Manager stops answering part-way, the command
asks again under the same key for up to two minutes; past that it reports the
outcome as unknown and keeps its services held for `openmapx control resolve`.

## Who is affected

Installations whose engines have built data, for example after a first data
download or a service build.

## Required action

None. Applying the same plan again links nothing twice, so `pnpm openmapx data
link` is always safe to run after a busy or unknown answer.
