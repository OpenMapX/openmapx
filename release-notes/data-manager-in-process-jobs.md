---
impacts: [migration]
---

## What changes

Live, predicted and maintenance traffic, transit catalog proposals, dataset
reloads and ambient place publication now run as durable Data Manager jobs, like
transit syncs and downloads. Migration `0066_update_system_job_rows` adds the
column that records the
host operations these jobs ask the operations agent for.

- Live traffic keeps running while a long job such as a transit sync is in
  progress. Catalog proposals, dataset reloads and ambient place changes
  (build, enable, disable, roll back, resume, discard) wait for their turn like
  other data jobs: while another one runs, they answer `409`.
- Adding, removing, enabling or disabling a transit source starts the transit
  sync directly. While another data job runs, the request answers `409` with
  the reason `in-flight`.
- When Data Manager restarts during one of these jobs, the job ends as
  `interrupted` once the agent has answered for every host operation it started.
  Until then it keeps configuration changes and other data jobs waiting.

## Who is affected

Every Docker deployment. Operators who start catalog proposals, dataset reloads
or ambient place changes while another data job runs now get `409`.

## Required action

Install fresh, as `update-system-fresh-install.md` describes: job rows the old
in-process path left unfinished are not closed by this release.
