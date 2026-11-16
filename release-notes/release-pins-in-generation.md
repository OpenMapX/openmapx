---
impacts: [breaking, operator-action]
---

## What changes

A configuration generation now renders the release's image pins into its own
compose file and keeps the release manifest beside it. The release overlay
`infra/docker/state/ops-agent/releases/docker-compose.release.yml`, the release
store's `current.json`, `latest.json` and `selections.json` and the release-store
lock are gone. `compose release` renders a new generation pinning the resolved
release, `compose release --clear` and **Clear selected release pin** render the
applied configuration again without pins, and every other render keeps the
applied pins; a start without pins pins the configured release. The agent keeps a cache of the manifests it checked, named by
digest, under `state/ops-agent/releases/`.

`openmapx control rollback` returns to the configuration that was applied with
the previous release, with that release's pins, and recreates the services in the
self-update order. It refuses when no such configuration is retained, and when the
database has a migration newer than the previous release ships; CI now records
each release's newest migration in its release manifest. Rolling back also
reverts the configuration made since: the release selection, the selected
services, service configuration and secrets.

## Who is affected

Every installation upgrading from an earlier release, and operators who read or
edited the overlay file. Release manifests published before this change carry no
migration information, so rollback to one of them is refused.

## Required action

Install this release fresh, or after upgrading run `pnpm openmapx compose
release` (or apply the release through **System → Updates**) so that the applied
configuration pins it; then remove the old overlay file and the
`state/ops-agent/releases/store` directory by hand. Read the rollback section of
the upgrade guide before using `openmapx control rollback`, and re-apply any
configuration change you still want after a rollback.
