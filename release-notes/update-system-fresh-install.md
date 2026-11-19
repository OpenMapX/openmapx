---
impacts: [breaking, migration, operator-action]
---

## What changes

This release replaces the update system's records: the operations agent's job
journal, its lease store and maintenance records, the control records of Data
Manager and the host CLI, and the Data Manager job rows that the removed
in-process job path wrote. Each execution now has one record instead of
several: the agent keeps it on the operation's row in its job journal
(`infra/docker/state/ops-agent/jobs-v1.json`), and every other execution keeps it
as one file under `control/executions` in its role's state directory, which no
longer holds separate effect, effect-start or lifecycle files. None of the old
records is converted. An agent that
finds an old journal row refuses to start, and a Data Manager job row left
unfinished by the old path keeps every configuration change refused, because
nothing in the new code finishes it.

## Who is affected

Every installation created before this release. Fresh installations are not
affected.

## Required action

Install fresh from this release with an empty API database and an empty
`infra/docker/state`. Do not upgrade an existing installation in place, and do
not delete individual old files to make it start: there is no supported path
from the old records to the new ones.
