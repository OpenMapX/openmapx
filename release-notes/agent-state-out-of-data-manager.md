---
impacts: [security]
---

## What changes

The operations agent keeps its own state in `infra/docker/state/ops-agent/`,
outside `infra/docker/data/`: its job journal, its self-update handoff record,
the trusted-configuration queue it shares with app-api, and its
privacy-extraction scratch. data-manager mounts the data directory read-write
as the same user, so state there could be rewritten by it: the journal, a
handoff record whose previous overlay a rollback would restore, and queued
configuration snapshots, including secrets. Only app-api (the queue, and the
integration store read-only) and Traefik (its own files, read-only) mount
parts of it.

Related fixes:

- The agent writes Valhalla's traffic-generations manifest, and its
  maintenance fence, through a directory it opened without following
  symlinks, with a random exclusive temporary. A symlink data-manager plants
  there can no longer redirect the write onto another file the agent can
  write. `service-selection.json` and Traefik's `generated-routes.yml` are
  written the same way.
- Backups and the data inventory are read from their own directories rather
  than from the checkout root, so a checkout cloned under a umask of `002` no
  longer shows them as unavailable.
- The CLI explains a community repository whose manifests no longer match the
  agent's record, and how to recover, instead of printing a stack trace.

## Who is affected

Every Docker deployment.

## Required action

None. The agent creates its state directories owner-only on its first start
and at every configuration render.
