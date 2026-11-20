---
impacts: [migration]
---

## What changes

Data Manager keeps every record of a job on the job's own row in
`data_manager.jobs` instead of in files under
`infra/docker/state/data-manager/control`. Migration
`0066_update_system_job_rows` adds three columns: `execution_admission` and
`execution_progress` hold the job's execution record, inserted together with the
job row, and `execution_completion` records how the job's work ended. The
execution record's settlement also holds the job's terminal status and finish
time, so the separate terminal, worker and proxy recovery files are gone. The
execution record is also the job's only record of its children (the operations
it asks the operations agent to run): each reserved child has one cell holding
what it acts on (a transit candidate, which no longer has a file of its own),
its binding, its grant and how Data Manager last observed it. The same
migration drops the `execution_children` column that recorded them a second
time. The only per-job file left is the Transitous runner attempt journal, which
holds each runner request's capability and stays out of the database and its
backups. The control prune removes a pruned job's row with its other records.

Data Manager's record of a configuration fence is now the fence row itself.
The same migration adds a `refused` state to
`data_manager.configuration_fence`: a preparation Data Manager refused is
recorded, so the same request is refused again. `openmapx control resolve` and
the agent treat a refused row as no fence. A preparation removes fence rows that
were settled or refused more than 72 hours earlier.

Restoring a backup closes the Data Manager jobs that were still open when it was
taken, as before, and now also drops their execution records and work
completions. Data Manager deletes such a closed job row three days after it
finished, once its request key has expired. The migration also adds
`released_at`, set once a finished job has released its own lease; Data
Manager's startup recovery looks only at unfinished jobs and at finished jobs
that have not released yet, and never at a job a restore closed.

## Who is affected

Every Docker deployment. The migration runs with the API's other migrations.

## Required action

None beyond the fresh installation that `update-system-fresh-install.md`
requires: the new columns start empty and nothing reads the old files.
