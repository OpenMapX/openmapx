---
impacts: [migration]
---

## What changes

The `0044_job_stages_job_id_index` migration adds an index on
`data_manager.job_stages.job_id`. Deleting a data-manager job cascades to its
stages, and without the index each deleted job scanned the whole stage table.
Migration `0039_drop_poi_ingest` deletes every former POI-ingest job in one
statement, which held app-api in its startup migration for about 30 minutes on
an installation with 34,000 such jobs.

## Who is affected

Every installation gets the index. An installation that has not yet applied 0039
and kept a large POI-ingest job history still runs that delete without the index,
because 0044 applies after it.

## Required action

None. app-api applies the migration at startup. Building the index takes well
under a second for a stage table of about 130,000 rows and briefly blocks writes
to `job_stages`; data-manager job recording waits for it.
