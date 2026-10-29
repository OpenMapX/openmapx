---
impacts: [migration, operator-action]
---

## What changes

The operations agent's container stops mounting the whole checkout. It
mounts `infra/docker` read-only, for `.env` and your overrides in
`infra/docker/overrides`, and `infra/docker/state`, `data`, `secrets` and
`backups` read-write, all at their host paths. Everything else it uses comes
from its image and its state.

Only a render on the host moves the agent to these mounts, and only once the
host has everything an agent without the checkout needs. Until then the
agent keeps the whole checkout, and the render says "The operations agent
keeps the whole checkout mounted", listing each missing item with its fix.
The agent's own renders and the admin panel's changes keep whichever mounts
the agent runs with. `services update`, `services start` and `compose up`
check again before they recreate the agent, and recreate nothing when
something is missing.

## Who is affected

Every Docker deployment, at its first host update to this release. After a
panel update to this release the agent keeps the whole checkout until the next
host update.

## Required action

Update on the host as usual:

```bash
pnpm openmapx compose release
pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner
```

If the render says the agent keeps the whole checkout, fix each listed item
and run the update again. Most often:

- recreate a container that still mounts the checkout's `services/`;
- select a release so the one-time import of your service file edits can run;
- on a new installation, update once more after the agent's first start.

To roll back, select the earlier release with `pnpm openmapx compose release
<release>` and update on the host, or apply it from the admin panel. That
release works with either mounts, and its renders give the agent the whole
checkout again. After a panel apply, the agent keeps the narrow mounts until
it is next recreated, for example with `pnpm openmapx services update
ops-agent`.
