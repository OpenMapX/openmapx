---
impacts: [security, migration, operator-action]
---

## What changes

The applied configuration, the service selection and the release state move
out of `infra/docker` into the operations agent's state directory,
`infra/docker/state/ops-agent/`, which only the deployment's user can reach:

- `configuration/current` and `configuration/generations/` replace
  `.trusted-config-current` and `.trusted-config-generations/`;
- `service-selection.json` moves there;
- `releases/store/`, `releases/evidence/` and
  `releases/docker-compose.release.yml` replace `.ops-agent-releases/`,
  `.release-evidence/` and `docker-compose.release.yml`.

A checkout cloned under a umask of `002` leaves `infra/docker` writable by its
group, and another account of that group could plant a selection, a pointer to
a generation of its own or a release overlay there. The agent and the CLI now
read none of these from `infra/docker`. They no longer change its permissions
either: a state directory that its group or others can reach is refused with a
message, not repaired.

`infra/docker/.env` is used only as the operator's own file: a regular file
owned by the deployment's user, with one link and no group or other write.
Rendering, service commands and the agent refuse any other `.env`; the agent's
startup log and `pnpm openmapx check` (**Run diagnostics**) name the problem
and the fix. The CLI creates it with mode `0600`, as before.

Related fixes:

- The agent's backup and privacy-extraction anchors must be owned by its own
  user.
- The Pelias Compose file is written atomically, with mode `0600`.

## Who is affected

Every Docker deployment. Operators who run `docker compose -f infra/docker/...`
by hand need the new paths shown in [Managing services](../docs/docs/install/managing-services.md).

## Required action

Only if `infra/docker/.env` is not the deployment user's own regular file, has
more than one link, or its group or others can write it, fix it before
updating:

```bash
chown "$(id -u)" infra/docker/.env && chmod 600 infra/docker/.env
```

Nothing else. The first `pnpm openmapx compose render` of this release, or the
new agent's start after a panel self-update, copies the earlier release's
applied configuration into the new location. The service selection comes from
that generation's applied services, never from the old, group-writable
`service-selection.json`. Release manifests and pointers are copied only if
they are the deployment user's own files and pass the store's checks. The
overlay is never copied: it is rendered again from the manifest it selected or,
when `compose release` selected it and the store holds no manifest of it, from
its own pins and evidence once they give exactly its bytes again, so the
selected release stays selected. An
unfinished release update of the previous agent (`.ops-agent-releases/transaction.json`)
stops the release migration until that agent recovers it. While the earlier
overlay's release has not come over, for that reason or because the overlay
could not be verified, nothing selects or applies a release automatically:
`services update` and `services start` of the release's services, `compose up`, `compose pull` and the admin
panel's update refuse and name the reason, as does **Run diagnostics**. Let the
previous agent finish its update, or select a release with
`pnpm openmapx compose release` (or clear it with `--clear`). An earlier applied
configuration whose pointer is not the deployment user's own is refused: remove
`infra/docker/.trusted-config-current` to render without it, and the admin
panel applies its saved settings again.

Nothing is moved, so `infra/docker/data` can be a filesystem of its own. The
old files stay as they were, for a rollback to an earlier release, and nothing
of this release reads them again. Until this release's agent has started and no
self-update helper is running, writers also take the earlier releases' lock,
`infra/docker/.trusted-config-writer`, so an earlier agent never commits at the
same time. A rollback restores an earlier agent with the configuration it left;
changes applied after the update are not carried back.
