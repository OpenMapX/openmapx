---
title: Upgrading
description: Keep a self-hosted OpenMapX deployment current — back up, pull new code and images, re-render the stack, and recreate containers.
sidebar_position: 6
---

# Upgrading

Upgrading an OpenMapX deployment means moving the checkout to newer code and the
running containers to newer images. The same `openmapx` CLI that brought the
stack up drives the upgrade: you pull the latest code, re-render the compose
stack if anything structural changed, fetch the newer images, and recreate the
containers. Database migrations apply themselves on the next API boot, so there
is no separate migration step to run.

This page covers a normal code/image upgrade. Refreshing the *data* a deployment
serves — new OSM extracts, GTFS feeds, rebuilt indexes — is a different cadence
and lives in [Preparing data](./preparing-data.md).

:::tip[Back up first]
The very first step of any upgrade is a backup. The
[Back up first](#1-back-up-first) section below shows the one command that does
it. Don't skip it — it's the only thing that makes a bad upgrade reversible.
:::

## How an OpenMapX upgrade works

Two things move during an upgrade, and they move independently:

- **The code** — the monorepo checkout, including the service and integration
  manifests, the `openmapx` CLI, and the database migrations. This advances with
  `git pull`.
- **The images** — the application containers. The core app services
  (`app-api`, `app-web`, `data-manager`) run **prebuilt images published to the
  GitHub Container Registry** (`ghcr.io/medformatik/openmapx-*`), pinned to the
  `latest` tag in their manifests. They are **not built on your host** — a new
  app version arrives by *pulling* the newer `latest` image, not by rebuilding.

Because of that split, `git pull` alone does **not** update the running app: it
updates the manifests and the CLI, but the containers keep running whatever image
they already pulled. You get the new app version when you `compose pull` and
recreate the containers. The steps below do both, in the right order.

## 1. Back up first

The CLI snapshots every backup-enabled service volume — the PostGIS database
(streamed `pg_dump | gzip`) and the other small stateful volumes (`tar`) — into
`infra/docker/backups/`:

```bash
pnpm openmapx backup create --name pre-upgrade
```

Heavy region-derived index volumes (Nominatim, Pelias/Elasticsearch, Valhalla,
MOTIS, Photon, TileServer, Overpass) are intentionally **excluded** — they rebuild
from source data and would dominate the snapshot for no recovery benefit. What
the backup captures is the irreplaceable state: your database (users, admin
config, integration settings, ingested POI data).

Also copy your environment file aside, since it holds the secrets the whole stack
depends on and is never part of a code pull:

```bash
cp infra/docker/.env infra/docker/.env.bak
```

If an upgrade goes wrong, restore the snapshot:

```bash
pnpm openmapx backup list                      # show available snapshots
pnpm openmapx backup restore pre-upgrade       # restore everything
```

See the [backup command reference](https://github.com/OpenMapX/openmapx/wiki/CLI-Reference#backup)
for per-service restore, the version-compatibility check, and `--stop-running`.

## 2. Pull the latest code

From the repo root, fetch the new code and reinstall the workspace. A new release
can change dependencies, the CLI, or the manifests, so always reinstall after a
pull:

```bash
git pull
pnpm install
```

At this point your checkout is current — new manifests, new CLI behavior, and any
new database migrations are now on disk — but the running containers are
unchanged. The next steps roll the running stack forward to match.

:::note[Read the release notes]
Before a major upgrade, skim the project's release notes for breaking changes —
a renamed environment variable, a new required secret, or a manifest change that
needs attention. OpenMapX is under active development, so an occasional manual
step between versions is expected.
:::

## 3. Re-render the compose stack

If the upgrade changed any service manifest (a new image tag, a new volume, a
changed port, an added core service), the generated compose file needs to be
regenerated from the updated manifests:

```bash
pnpm openmapx compose render
```

This rewrites `infra/docker/docker-compose.generated.yml` and the hardlink plan
from your current manifests and `infra/docker/.env`. The output is deterministic,
and re-rendering when nothing changed is harmless — so when in doubt, render. The
recreate command in the next step also re-renders for you, so you can skip this
as a standalone step unless you want to inspect the diff first.

## 4. Pull new images and recreate containers

This is the step that actually swaps in the new app version. `services recreate`
re-renders, refreshes the hardlinks, pulls the newest images, and force-recreates
the containers:

```bash
pnpm openmapx services recreate app-api app-web data-manager
```

Under the hood this runs `docker compose pull` followed by
`docker compose up -d --force-recreate` for the named services. The core app
services pull their newer `latest` image from GHCR; any locally indexed engine
that has no registry image is simply skipped by the pull (a warning, not an
error) and recreated from its existing data.

To roll the **entire** enabled stack forward in one shot instead of naming
services, pull everything and bring the stack up:

```bash
pnpm openmapx compose pull
pnpm openmapx compose up
```

`compose up` re-renders, re-applies the hardlink plan, and runs
`docker compose up -d`, which recreates only the containers whose image or
configuration actually changed. Heavy backend engines that didn't change are left
running untouched.

:::note[Pull vs. build]
There is no "rebuild the app" step in a normal upgrade. The application images are
pulled from GHCR — `compose pull` (or the pull baked into `services recreate`) is
how you get the new version. You only build images yourself if you're doing local
development against the source, which is outside the self-hosting flow.
:::

## 5. Database migrations apply automatically

OpenMapX does not have a separate "run migrations" command for a self-host
upgrade. The `app-api` container **applies pending Drizzle migrations on every
boot**: at startup it runs the migration files bundled in the image against the
database, and the migrator is **idempotent** — it skips migrations that are
already applied and only runs the new ones.

So once the new `app-api` image starts (step 4), any schema changes that shipped
with the release are applied automatically. You can confirm it ran cleanly in the
API logs:

```bash
pnpm openmapx services logs app-api --tail 100
```

A successful upgrade logs `Database migrations applied`. If a migration fails,
the error is logged there — this is exactly the situation the
[pre-upgrade backup](#1-back-up-first) exists to protect against, so restore the
snapshot before investigating.

:::caution[Migrations move forward only]
Drizzle migrations are forward-only — there is no automatic down-migration. Once a
new `app-api` has migrated the database, rolling back to an older app image is not
supported unless you also restore the matching database backup. This is why the
backup in step 1 is non-negotiable for any upgrade that crosses a schema change.
:::

## 6. Verify the upgrade

Check that every container came back healthy and the API is serving:

```bash
pnpm openmapx services status                  # container + health state for all services
curl -s http://localhost:3001/api/status       # API + integration health JSON
```

Then load the app in a browser and exercise the core paths — search, directions,
and any self-hosted engines you run. If a service is stuck, tail its logs:

```bash
pnpm openmapx services logs <id> --follow
```

For the full set of after-the-fact checks (per-engine curl probes for Valhalla,
Nominatim, Photon, Overpass, MOTIS, and TileServer), see the verification commands
in the [self-hosting guide](https://github.com/OpenMapX/openmapx/wiki/Self-Hosting-Guide#verification).

## Reclaiming disk after an upgrade

Pulling new `latest` images leaves the previous ones on disk as dangling layers.
Once you've confirmed the upgrade is healthy, prune them:

```bash
docker image prune
```

This removes only unreferenced images, so it won't touch what the running stack
uses.

## Upgrading community service repositories

If you've installed third-party [services](../overview/how-it-works.md) from Git
URLs, they upgrade on their own cadence rather than with the monorepo. Fetch the
latest commit for an installed repo, then re-render and bring the stack up:

```bash
pnpm openmapx repos refresh <hash>             # git fetch + reset to the repo's HEAD
pnpm openmapx compose render
pnpm openmapx compose up
```

## Where to go next

- **[Preparing data](./preparing-data.md)** — refreshing OSM extracts, GTFS
  feeds, and rebuilding engine indexes (a separate cadence from code upgrades).
- **[Managing services](./managing-services.md)** — restarting, rebuilding, and
  the staggered-startup order for heavy engines.
- **[Configuration](./configuration.md)** — the `infra/docker/.env` reference, in
  case an upgrade introduces a new required variable.
