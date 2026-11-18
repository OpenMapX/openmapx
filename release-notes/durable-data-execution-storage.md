---
impacts: [migration, operator-action]
---

## What changes

Migration 0042 adds retained execution identities, deadlines, ownership versions,
bounded child receipts and a configuration maintenance guard to data-manager jobs.
Ref-only catalog approval is disabled until paired validation and activation are
available. Every data job is now such a durable execution; see
`data-manager-in-process-jobs.md` for the jobs that ran outside it before.

## Who is affected

Self-hosted installations upgrading the API, data manager and operations agent.

## Required action

Apply the normal API database migrations before enabling durable data execution.
Upgrade the control services together. Do not remove unresolved execution or
configuration maintenance records to retry work: uncertain outcomes retain their
original identity and require reconciliation; `openmapx control status` shows
them.
