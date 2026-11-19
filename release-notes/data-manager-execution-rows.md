---
impacts: [migration]
---

## What changes

Data Manager keeps each job's execution record on the job's own row instead of in
a file under `infra/docker/state/data-manager/control/executions`. Migration
`0066_update_system_job_rows` adds the `execution_admission` and
`execution_progress` columns to
`data_manager.jobs`; the control prune removes a pruned job's row with its other
records.

Data Manager's record of a configuration fence is now the fence row itself.
The same migration adds a `refused` state to `data_manager.configuration_fence`: a
preparation Data Manager refused is recorded, so the same request is refused
again. `openmapx control resolve` and the agent treat a refused row as no fence.
A preparation removes fence rows that were settled or refused more than 72 hours
earlier.

Restoring a backup closes the Data Manager jobs that were still open when it was
taken, as before, and now also drops their execution records.

## Who is affected

Every Docker deployment. The migration runs with the API's other migrations.

## Required action

None beyond the fresh installation that `update-system-fresh-install.md`
requires: the new columns start empty and nothing reads the old files.
