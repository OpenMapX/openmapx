---
impacts: [migration, operator-action]
---

## What changes

The operations agent's two stores move out of the checkout into its state
directory: installed integrations from `custom_integrations/` to
`infra/docker/state/ops-agent/custom-integrations/`, and community service
repositories from `services/.community/` to
`infra/docker/state/ops-agent/community/`. Both are owner-only. `app-api` mounts
the integration store read-only at the same path as before,
`/app/custom_integrations`, so `OPENMAPX_CUSTOM_INTEGRATIONS_DIR` doesn't change.

The first configuration render of this release, or the new agent's start after
a panel self-update, copies both stores once. Each entry is checked against
the agent's records: an integration's files by their recorded SHA-256, a
repository's service manifests by theirs, with the copy an unfinished change
keeps for rolling back. From then on the agent installs, updates and removes
only in the new stores. Nothing is moved; the earlier copies stay in the
checkout.

## Who is affected

Installations with installed integrations or community service repositories.
Others get two empty stores and nothing to do.

## Required action

Read the render's output, or run `pnpm openmapx check` (**Run diagnostics** in
the admin panel). An entry that matched none of its recorded states, or that
had no record, was not copied and is named there, with the reason, for as long
as it is still in the checkout. Install it again through the admin panel, then
delete it from the checkout.

On a rollback to an earlier release, its agent sees the stores in the checkout
as they were at the copy: installs and removals made after the update aren't
visible there. The integration records are shared by both releases, so an
integration installed after the update shows there as needing a reinstall, and
one removed after the update as not installed through the agent.
