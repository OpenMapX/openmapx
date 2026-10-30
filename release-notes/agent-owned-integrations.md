---
impacts: [security, migration]
---

## What changes

The operations agent now owns installed integrations under
`custom_integrations/`, as it already owns community service repositories. It
downloads each integration artifact itself, checks its SHA-256, installs it as
a transaction that the admin panel commits or rolls back, and records the
SHA-256 of every file it installed in its own state directory
(`infra/docker/state/ops-agent/integrations/`), which no other service mounts.

- The agent, and the CLI it runs, load an installed integration's
  configuration schema only while its `manifest.json` has exactly the recorded
  bytes. File owners and modes in `custom_integrations/` decide nothing, so a
  checkout under a umask of `002` needs no `chmod`.
- An integration the agent did not install, or whose files changed, is left
  out and reported in the agent's startup log and in **Run diagnostics**. It no
  longer stops the agent from authorizing other configuration changes.
- `app-api` mounts `custom_integrations/` read-only and serves only files whose
  bytes match the agent's record. `pnpm openmapx integrations install` and
  `remove` go through the agent when the stack runs.
- Migration `0042` adds `installed_integration.last_transaction_id`, the
  commit point of an integration install.

## Who is affected

Every Docker deployment with community integrations installed.

## Required action

None for integrations installed from **Admin → Extensions**. On its first start
after the upgrade, `app-api` asks the agent to verify each one against its
extension's pinned artifact, downloaded again; it is recorded only if the files
on disk are exactly the artifact's files. Until then it is not loaded.

Install again, from **Admin → Extensions** or with
`pnpm openmapx integrations install`, any integration that **Run diagnostics**
reports as needing a reinstall: one whose files differ from its artifact, and
every integration installed with `pnpm openmapx integrations install`, since
nothing records where it came from. If an artifact could not be downloaded, the
next `app-api` start tries again.

Update `app-api` and the operations agent together, as a normal update does:
`app-api` sends operations that earlier agents refuse.
