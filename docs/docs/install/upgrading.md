---
title: Upgrading
description: Keep a self-hosted OpenMapX deployment current — optionally back up, pull new code and images, re-render the stack, and replace containers.
sidebar_position: 6
---

# Upgrading

Upgrading an OpenMapX deployment means moving the checkout to newer code and the
running containers to newer images. The same `openmapx` CLI that brought the
stack up drives the upgrade: you pull the latest code, re-render the compose
stack if anything structural changed, fetch the newer images, and replace the
containers. Database migrations apply themselves on the next API boot, so there
is no separate migration step to run.

This page covers a normal code/image upgrade. Refreshing the *data* a deployment
serves — new OSM extracts, GTFS feeds, rebuilt indexes — is a different cadence
and lives in [Preparing data](./preparing-data.md).

:::tip[Backup recommended]
A pre-update backup is optional, but recommended when the deployment contains
state you cannot readily recover. The admin panel's update confirmation leaves
this choice with the operator and enables it by default.
:::

## How an OpenMapX upgrade works

Two things move during an upgrade, and they move independently:

- **The code** — the monorepo checkout, including the service and integration
  manifests, the `openmapx` CLI, and the database migrations. This advances with
  `git pull`.
- **The images** — the application containers. The core app services
  (`app-api`, `app-web`, `data-manager`) run **prebuilt images published to the
  GitHub Container Registry** (`ghcr.io/openmapx/*`). A complete release is
  selected through the single `ghcr.io/openmapx/release-manifest:latest`
  pointer, which maps every application image to an immutable digest. They are
  **not built on your host**.

Because of that split, `git pull` alone does **not** update the running app: it
updates the manifests and the CLI, but the containers keep running whatever image
they already pulled. You get the new app version by resolving the complete
release manifest, then pulling and replacing the exact image set. The steps
below do both, in the right order.

## 1. Optional: create a backup

When selected, the CLI snapshots every backup-enabled service volume — the PostGIS database
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

You may also copy your environment file aside, since it holds the secrets the
whole stack depends on and is never part of a code pull:

```bash
cp infra/docker/.env infra/docker/.env.bak
```

If an upgrade goes wrong, restore the snapshot:

```bash
pnpm openmapx backup list                      # show available snapshots
pnpm openmapx backup restore pre-upgrade       # restore everything
```

See [Backup & restore](../administration/backup-and-restore.md) for per-service
restore, the version-compatibility check, and `--stop-running`.

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
update command in the next step also re-renders for you, so you can skip this
as a standalone step unless you want to inspect the diff first.

## 4. Resolve the complete release and replace containers

This is the step that actually swaps in the new app version. The short form
resolves the aggregate release pointer, writes the overlay, and replaces the
core containers:

```bash
pnpm openmapx compose release
pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner
```

`compose up`, `services start`, and `services update` refuse to run release
services when no overlay exists and the release manifest cannot be resolved.

The equivalent manual procedure pulls the one aggregate release pointer and
writes the same local Compose overlay by hand. The overlay survives later
`compose render` runs because it is a separate file:

```bash
docker pull ghcr.io/openmapx/release-manifest:latest
release_container=$(docker create ghcr.io/openmapx/release-manifest:latest true)
docker cp "$release_container:/release-manifest.json" /tmp/openmapx-release-manifest.json
docker rm "$release_container"

release_api="$(jq -er '.images.api' /tmp/openmapx-release-manifest.json)" || exit 1
release_web="$(jq -er '.images.web' /tmp/openmapx-release-manifest.json)" || exit 1
release_data_manager="$(jq -er '.images["data-manager"]' /tmp/openmapx-release-manifest.json)" || exit 1
release_ops_agent="$(jq -er '.images["ops-agent"]' /tmp/openmapx-release-manifest.json)" || exit 1
release_transitous_runner="$(jq -er '.images["transitous-runner"]' /tmp/openmapx-release-manifest.json)" || exit 1
release_transitous_tools="$(jq -er '.images["transitous-tools"]' /tmp/openmapx-release-manifest.json)" || exit 1

if [[ ! "$release_api" =~ ^ghcr\.io/openmapx/api@sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "$release_web" =~ ^ghcr\.io/openmapx/web@sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "$release_data_manager" =~ ^ghcr\.io/openmapx/data-manager@sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "$release_ops_agent" =~ ^ghcr\.io/openmapx/ops-agent@sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "$release_transitous_runner" =~ ^ghcr\.io/openmapx/transitous-runner@sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "$release_transitous_tools" =~ ^ghcr\.io/openmapx/transitous-tools@sha256:[0-9a-f]{64}$ ]]; then
  echo "The release manifest contains an invalid image reference" >&2
  exit 1
fi

cat > infra/docker/docker-compose.release.yml <<EOF
services:
  app-api:
    image: $release_api
  app-web:
    image: $release_web
  data-manager:
    image: $release_data_manager
    environment:
      OPENMAPX_TRANSITOUS_TOOLS_IMAGE: $release_transitous_tools
  ops-agent:
    image: $release_ops_agent
  transitous-runner:
    image: $release_transitous_runner
EOF

release_compose=(docker compose -f infra/docker/docker-compose.generated.yml -f infra/docker/docker-compose.release.yml)
"${release_compose[@]}" pull app-api app-web data-manager ops-agent transitous-runner
"${release_compose[@]}" up -d --force-recreate app-api app-web data-manager ops-agent transitous-runner
```

The `release-manifest:latest` tag moves atomically only after every image in its
release has passed promotion. The generated overlay therefore keeps `app-api`,
`app-web`, `data-manager`, `ops-agent`, `transitous-runner`, and the Transitous
helper on the same release.

:::note[Admin updater and later service commands]
The admin system updater performs this same release-manifest resolution and
writes `docker-compose.release.yml` atomically after every digest-pinned image
has been pulled. API and CLI service lifecycle commands automatically include an
existing release overlay, so restarting or re-rendering the stack retains the
digest-pinned release. Keep the overlay with the deployment;
delete it only when intentionally leaving the published OpenMapX release channel.
Forks and mirrored registries select their own channel with
`OPENMAPX_RELEASE_MANIFEST_IMAGE` (see [Configuration](./configuration.md)).
:::

To reconcile the **entire** enabled stack while retaining the selected app
release, use the same overlay with Compose:

```bash
"${release_compose[@]}" pull
"${release_compose[@]}" up -d
```

Run `pnpm openmapx compose render` before these commands whenever manifests or
the service selection changed; it refreshes the generated base file without
overwriting `docker-compose.release.yml`. Heavy backend engines that did not
change are left running untouched.

:::note[Pull vs. build]
There is no "rebuild the app" step in a normal upgrade. The application images are
pulled by immutable digest from GHCR through the aggregate release manifest. You
only build images yourself if you're doing local development against the source,
which is outside the self-hosting flow.
:::

:::caution[Stricter `DATA_MANAGER_URL` validation]
`app-api` now refuses a `DATA_MANAGER_URL` that is plain `http://` on any host
other than `localhost`, `127.0.0.1`, `::1` or the Compose service name
`data-manager`, and rejects URLs with credentials, a path prefix or a query
string. If you reach the data-manager over HTTP on a LAN address or a custom
service name, list that hostname in `DATA_MANAGER_PLAINTEXT_HOSTS` (see
[Configuration](./configuration.md)); a path prefix must be moved to a
dedicated hostname or port.
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
the error is logged there. If you created an optional
[pre-upgrade backup](#1-optional-create-a-backup), restore it before attempting a rollback.

:::caution[Migrations move forward only]
Drizzle migrations are forward-only — there is no automatic down-migration. Once a
new `app-api` has migrated the database, rolling back to an older app image is not
supported unless you also restore the matching database backup. For upgrades
that cross a schema change, consider taking the optional backup in step 1 when
the deployment contains state you cannot readily recreate.
:::

## 6. Verify the upgrade

Check that every container came back healthy and the API is serving:

```bash
pnpm openmapx services status                  # container + health state for all services
curl -s https://${DOMAIN}/api/status           # API + integration health JSON (via Traefik)
```

Then load the app in a browser and exercise the core paths — search, directions,
and any self-hosted engines you run. If a service is stuck, tail its logs:

```bash
pnpm openmapx services logs <id> --follow
```

For per-engine checks after an upgrade, see the verification steps in the
relevant guides — [routing engines](../guides/routing-engines.md),
[geocoders](../guides/geocoders.md), [transit engines](../guides/transit-engines.md),
and [OSM data queries](../guides/osm-data-queries.md).

## OpenStreetMap contributions and OAuth token encryption

The release that adds
[OpenStreetMap place contributions](../features/osm-contributions.md) also turns
on **encryption at rest for stored OAuth provider tokens**, because a linked
OpenStreetMap account can now hold write permissions.

Nothing is required of you to upgrade, and both contribution flags stay off
until you set them.

Keep `BETTER_AUTH_SECRET` **stable and protected**. It is now the key material
for stored provider tokens as well as sessions. Rotating it deliberately is
supported, but every linked OAuth account will need to be re-linked afterwards —
Better Auth does not re-encrypt existing tokens under a new secret.

## Reclaiming disk after an upgrade

Pulling a new release leaves the previous images on disk as dangling layers.
Once you've confirmed the upgrade is healthy, prune them:

```bash
docker image prune
```

This removes only unreferenced images, so it won't touch what the running stack
uses.

## Upgrading community extensions

Third-party [extensions](../administration/community-extensions.md) upgrade on
their own cadence rather than with the monorepo. When a newer version is in the
catalog, update from the **Extensions** admin page, or on the CLI:

```bash
pnpm openmapx ext list            # shows which installed extensions have updates
pnpm openmapx ext update <id>     # re-pin every part to the catalog's current version
```

An update re-pins the bundle's service(s) and integration(s) together and
re-renders the stack as one orchestrated step.

### If `app-api` refuses to start after an interrupted extension update

Extension installs and updates write small recovery journals next to the files
they change — `services/.community/.rollback-*.json`,
`services/.community/.prepare-*.json`, and
`custom_integrations/.extension-install-journal-*.json`. If `app-api` crashes
mid-update, the next start replays those journals before it serves anything,
restoring the previous repository checkout, integration artifact, service
selection, and running containers. That replay is fail-closed: when a journal
refers to a backup or database row that no longer exists (for example after a
manual clean-up), `app-api` logs
`Service repository rollback reconciliation failed; refusing to start` with the
journal path and exits instead of guessing.

To recover, confirm the referenced repository or integration is in the state
you want, then delete the journal named in the log (and, for `.rollback-*`
journals, the matching `.rollback-*` backup directory) and start `app-api`
again. Never delete a journal whose backup still exists unless you intend to
keep the *new* files it was about to roll back.

## Air-quality API compatibility

The legacy OpenAQ station route
`GET /api/integrations/overlay-air-quality/air-quality/stations` remains available through
1 March 2027, but its `aqi` field is now `number | null`. OpenMapX no longer labels one instantaneous
PM2.5 concentration as a US AQI value. A station receives a numeric index only when a complete,
locally applicable index can be validated; otherwise clients must display the `pm25` concentration and
the observation time.

The route sends `Deprecation: true`, `Sunset: Mon, 01 Mar 2027 00:00:00 GMT`, and a
`rel="successor-version"` link to `/api/integrations/air-quality/stations`. Operators should migrate map
and API consumers to that canonical route. During the compatibility window, clients must accept
`aqi: null`, retain the per-station attribution/license, and treat 429/5xx responses as unavailable data,
not as zero or “good” air quality.

## Where to go next

- **[Preparing data](./preparing-data.md)** — refreshing OSM extracts, GTFS
  feeds, and rebuilding engine indexes (a separate cadence from code upgrades).
- **[Managing services](./managing-services.md)** — restarting, rebuilding, and
  the staggered-startup order for heavy engines.
- **[Configuration](./configuration.md)** — the `infra/docker/.env` reference, in
  case an upgrade introduces a new required variable.
