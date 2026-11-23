---
impacts: [operator-action]
---

## What changes

Data-manager jobs keep retained execution identities, deadlines, ownership
versions, bounded child receipts and a configuration maintenance guard.
Ref-only catalog approval is disabled until paired validation and activation are
available. Every data job is such a durable execution, including live, predicted
and maintenance traffic, transit catalog proposals, dataset reloads and ambient
place publication.

## Who is affected

Every Docker deployment.

## Required action

Install fresh, as `update-system-fresh-install.md` describes. Do not remove
unresolved execution or configuration maintenance records to retry work:
uncertain outcomes retain their original identity and require reconciliation;
`openmapx control status` shows them.
