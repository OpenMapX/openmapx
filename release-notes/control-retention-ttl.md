---
impacts: [breaking]
---

## What changes

Finished control records are now removed by a simple time-based prune: each
service deletes its own records for an operation 72 hours after the operation's
key expired, once its outcome is known and any target lease it held is
released. The prune runs at startup and hourly. The retention families,
retention clock, record counters, byte budgets and the
`controlRetention.acknowledge` operation are gone; the API keeps its copy of a
terminal result without acknowledging it to the operations agent. A service now
refuses new control work, before any effect, while its control state filesystem
has less than 64 MiB free. Operations whose outcome is unknown, or that need
recovery, are still kept until resolved, and they no longer use up the agent's
capacity for new work.

## Who is affected

Installations upgrading from an earlier release. Records written by the earlier
retention machinery are not converted: operations admitted with undated keys or
without an origin are no longer readable, and retention indexes from the earlier
release are left in place unused.

## Required action

Upgrade only when no operation is running or waiting for recovery, or install
this release fresh. Keep host clocks synchronised: a clock set back by days can
admit an expired operation key again once its records have been pruned.
