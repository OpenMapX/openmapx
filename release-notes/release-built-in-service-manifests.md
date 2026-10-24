---
impacts: [security]
---

## What changes

The operations agent and the fixed CLI it runs now take every built-in service
manifest (`services/<id>/service.json`) from the ops-agent image of the selected
release, not from the host checkout. Built-in manifests can grant host
privileges, so editing the checkout's copies no longer changes what the agent
renders or starts. The fixed CLI previously re-read them from the checkout
without the agent's checks, for service updates, builds, backups and data
commands.

The agent no longer refuses to start with "Release service authority is
unavailable" because a built-in manifest or its directory is group-writable, as
a umask of `002` leaves them after `git pull`. A release that adds a built-in
service also no longer needs the checkout updated before the new agent can
start, which admin-panel updates rely on.

## Who is affected

Every Docker deployment. Operators who edited a built-in `service.json` in their
checkout should know that the ops-agent now ignores those edits; the host
`pnpm openmapx` still reads the checkout.

## Required action

None. Keep the checkout at the selected release: services still mount their
configuration files from it. The agent's startup log and `pnpm openmapx check`
report built-in services that are missing from, changed in or not in the
release. The other permission checks still apply until a follow-up change: the
checkout directory, `services/`, integration manifests and their directories
must not be writable by the group or others.
