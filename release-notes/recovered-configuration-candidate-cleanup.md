---
impacts: [operator-action]
---

## What changes

Recovered application preparation now discards its verified inert configuration
candidate before publishing the failed outcome. The API can also finish this
cleanup when an earlier version already marked the original recovery failed.
The original failed canonical is preserved; no preparation or update is replayed.

## Who is affected

Installations whose expired, adopted-but-unadmitted preparation was recovered,
but whose next update fails with `Configuration writer unavailable` because the
original candidate remains prepared.

## Required action

Install the corrected API with the control services required by the preceding
unadmitted-preparation recovery fix. Keep the original cancellation and recovery
records. Reconciliation verifies them and finishes only their inert cleanup,
including a lost unlink acknowledgment. Changed or unavailable evidence remains
fenced. After verified cleanup, start a fresh checked update with the chosen
backup policy; this recovery creates no backup. Do not clear candidate flags or
replay an expired update manually.
