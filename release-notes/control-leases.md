---
impacts: [breaking, migration, operator-action]
---

## What changes

Every claim a writer makes on a service before changing its containers now
lives in one file in the operations agent's own state,
`infra/docker/state/ops-agent/leases.json`. Data Manager asks the agent for its
claims over HTTP; the host CLI, the agent's fixed CLI children and the
configuration helper write the file under its lock. The shared lease directory
on `/data` is gone.

Stop, restart, start, recreate, update, remove, `compose up` and `compose down`,
and backup create and restore all take a claim first, from the admin panel and
from the host CLI alike. While another operation holds one of the services, the
command is refused at once with a message that names the holding operation and
points to `openmapx control status`; before, `services restart` could run in the
middle of an update. A failure Docker reports releases the claim. A crash,
timeout, killed command or lost Docker daemon connection keeps it until an
operator resolves it.

The configuration writer, the lease store, the backup store and the CLI's update
receipt use lock files that another writer reclaims once their holder is
provably gone, instead of directories that needed a manual `rmdir` after a crash.

`openmapx control status|clear|resolve` is the operator exit: it shows held
claims, unfinished operations and lock holders, records the outcome of an
operation whose outcome is unknown (also settling Data Manager's configuration
fence for a configuration maintenance), and drops a claim or lock whose holder
is gone. Every clear and resolve is appended to
`infra/docker/state/ops-agent/control-audit.jsonl`.
`services recover-update` is removed. The database migration drops a column of
Data Manager's configuration fence that the signed certificates used.

## Who is affected

Every installation upgrading from an earlier release, and operators whose
scripts stop or restart services during updates or backups, which now refuse
while the services are held. Lease records and lifecycle receipts of the earlier
format are not converted.

## Required action

Install this release fresh, or upgrade only while no update, service lifecycle
command, backup or configuration apply is in progress. Remove an earlier
`infra/docker/data/.admin-target-control` directory by hand after the upgrade;
nothing reads it. When a command reports a held service after a crash, follow
[Operations whose outcome is unknown](../docs/docs/install/upgrading.md#operations-whose-outcome-is-unknown):
check the containers, then `openmapx control resolve --op <key> --as
committed|failed`. On macOS, and for a host CLI lock holder seen from a
container, a dead lock holder is not reclaimed automatically; check that it has
exited, then run `openmapx control clear --lock <name>`.
