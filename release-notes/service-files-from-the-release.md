---
impacts: [migration, operator-action]
---

## What changes

Built-in services mount the configuration files and scripts of the release the
stack runs, not the checkout's `services/`. The operations agent's image embeds
them. Render copies them, with each configuration generation, into
content-addressed directories in `infra/docker/state/ops-agent/service-files`,
which the containers mount read-only. The OTP and Pelias builds read the same
copies. Valhalla, which rewrites its `valhalla.json` on every start, runs from a
writable copy in `infra/docker/data/valhalla/config/valhalla.json`. Render seeds
that copy from the release's file and seeds it again only when that changes.

Deliberate changes go in overrides: whole files in
`infra/docker/overrides/services/<service>/<same path>`, used in place of the
release's file.

- An override render may not use fails the render, by name: a link, a second
  link, another owner, or one its group or others may write. A configuration
  saved in the admin panel then fails with that reason.
- An override of a path the release doesn't ship is reported and ignored. The
  exception is a YAML or TOML file in Traefik's dynamic directory, such as
  `auth.yml`, which is added to Traefik's configuration.
- Render, the agent's log, `pnpm openmapx check` and **Run diagnostics** list
  the overrides in use. They also flag those whose release file changed since
  the override was made; editing the override acknowledges the change.
- This replaces the earlier warning that the checkout's built-in services
  differ from the release's.

The first render of this release imports, once, every checkout service file
that differs from every version a release shipped, as an override, and lists
them. This covers Traefik's `auth.yml` and a `traefik.yml` naming
`basic-auth@file`, so a basic-auth gate stays. A file a container writes
(`valhalla.json`) is never imported, and nothing in the checkout is changed. A
checkout an earlier release left after panel updates holds only released
versions, so nothing is imported from it. Later checkout edits are reported as
unused.

The host CLI runs the checkout's code and manifests. A host render now reads
the selected release's service files from its operations-agent image, and
refuses while the checkout's service manifests or files differ from that
release's (overrides aside). It names the files and says what to do: wait until
the release of the checkout's commit is published and run
`pnpm openmapx compose release` again, or check out the release's source
revision. With no release selected yet, render uses the checkout's files and
says so. Under `OPENMAPX_RELEASE=local` the checkout's files are the
release's.

## Who is affected

Every installation that runs built-in services. Operators who edited files
under `services/` (Traefik basic auth, Martin sources, OTP configuration, and so
on) find those edits as overrides after the first render. Hosts that follow
`main` with the host CLI may see a render refused until the release of their
commit is published.

## Required action

- **After the upgrade, check the render's output, or `pnpm openmapx check`,
  for the files it imported.** From then on, edit those files in
  `infra/docker/overrides/services`, not in the checkout.
- **Select the release before rendering on a host.** The documented host
  update already does: `git pull`, `pnpm install`, `pnpm openmapx compose
release`, `pnpm openmapx compose render`. A first installation now runs
  `compose release` before `compose render`.
- **Choose when services recreate.** A container keeps mounting the checkout's
  files until it is recreated. Those files still hold the same bytes, and
  render, `check` and Run diagnostics list such containers. The documented host
  update, `services update` with a list of services, recreates only the
  services listed. A panel update recreates only the application services,
  which mount no service files. **The first stack-wide `pnpm openmapx compose
up` recreates every service whose mounts moved, PostGIS and Traefik
  included.** Run it when a restart of the database and the proxy suits you,
  or recreate services one at a time with `pnpm openmapx services update
<service>`. A later release stops mounting the checkout into the operations
  agent, and waits until no container mounts the checkout's service files.

Rollback: the release before this one mounts the checkout's files again,
which this release leaves untouched. Edits made only in `overrides/` meanwhile
do not apply there; carry them back to the checkout if you need them before
upgrading again.
