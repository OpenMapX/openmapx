---
impacts: [security]
---

## What changes

The operations agent's own state moves from `infra/docker/data/` to
`infra/docker/state/ops-agent/`: its job journal, its self-update handoff
record, the trusted-configuration queue it shares with app-api, and its
privacy-extraction scratch. data-manager mounts the data directory read-write
as the same user, so it could rewrite the journal, plant a handoff record whose
previous overlay a rollback would restore, and read queued configuration
snapshots, including secrets. No other service can reach the new location;
app-api mounts only the queue.

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

None. The first agent of this release imports the journal from the old
location, and a handoff record only while the helper replacing the previous
agent is still running; it discards any other record unread. The first
configuration render moves the queue and the scratch directory, which running
containers keep using. An older agent started afterwards, for example by
selecting an earlier release, starts with no job history.
