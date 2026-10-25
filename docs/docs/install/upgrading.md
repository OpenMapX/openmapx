---
title: Upgrading
description: Update the host checkout and pinned application release, verify migrations, and preserve recovery options.
sidebar_position: 6
---

# Upgrading

Update both the host checkout and the selected container images. API startup
applies pending database migrations from its image. Plan a maintenance window
and preserve recovery state before replacing services.

Refresh source datasets and indexes separately, following
[Preparing data](./preparing-data.md).

:::tip[Backup recommended]
A pre-update backup is optional, but recommended when the deployment contains
state you cannot readily recover. The admin panel's update confirmation leaves
this choice with the operator and enables it by default.
:::

## How an OpenMapX upgrade works

The host checkout supplies the CLI, service definitions, and configuration used
to operate the stack. Application images are prebuilt and selected through a
release manifest. A Git pull updates the checkout but leaves running containers
unchanged; a release selection writes image pins but does not replace containers.
Both operations are followed by an explicit service update.

Application release metadata selects seven digest-pinned images, including the
running API, web, data-manager, ops-agent, and Transitous runner plus matching
helper images. Some digests can be reused from an earlier release. Do not infer
the selected release from one image's source revision or a mutable tag. See
[Product releases](../developer/product-releases.md) for publication and security
scan behavior.

For a reproducible rollback reference, use the run-qualified manifest tag
`ghcr.io/openmapx/release-manifest:<commit>-<run-id>-<attempt>` (the identifier is
also stored in its JSON `release` field), or a manifest digest. Bare commit-SHA
aliases can move when a security refresh rebuilds the same source commit.

The release manifest acts as a **release lockfile**. Atomic release selection
means an update chooses one complete set of image digests. Container replacements
still happen in steps; it does not promise a simultaneous switch or automatic
rollback of database changes. The docs website has its own publication channel
and is not part of this application update.

## 1. Optional: create a backup

The backup command captures declared backup targets under
`infra/docker/backups/`: PostgreSQL as a compressed logical dump and other
included volumes as tar archives.

```bash
pnpm openmapx backup create --name pre-upgrade
```

Heavy region-derived index volumes (Nominatim, Pelias/Elasticsearch, Valhalla,
MOTIS, Photon, TileServer, Overpass) are excluded from ordinary volume backups.
Rebuilding them can take substantial time; keep an independent artifact strategy
if recovery time requires it. Backups also include declared managed Dawarich state when selected; its
location history and attachments require special care. Do not assume every
bind-mounted file or generated secret is captured.

Preserve deployment configuration, generated secret files, and required recovery
state separately under a protected operator backup policy. A copy of `.env` alone
is not sufficient for recovery; keep encryption keys and the erasure journal
needed by restore. Do not include private subject-export artifacts. For a local
configuration safety copy:

```bash
cp -p infra/docker/.env infra/docker/.env.bak
chmod 600 infra/docker/.env.bak
```

A restore overwrites data and has version and erasure-journal checks. Inspect
the snapshot and follow [Backup and restore](../administration/backup-and-restore.md)
before restoring. When appropriate, stop clients through the restore workflow:

```bash
pnpm openmapx backup list                      # show available snapshots
pnpm openmapx backup restore pre-upgrade --stop-running
```

See [Backup & restore](../administration/backup-and-restore.md) for per-service
restore, the version-compatibility check, and `--stop-running`.

## 2. Pull the latest code

From the repo root, inspect `git status` and preserve local customizations before
fetching code. Use a fast-forward pull so unexpected branch divergence stops for
review, then reinstall the locked workspace. A new release
can change dependencies, the CLI, or the manifests, so always reinstall after a
pull:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
```

The ops-agent runs the built-in service and integration manifests of its own
release, not the checkout's, and checks no file permissions in it. The checkout
must still be writable only by the operator's account: services mount
configuration files from it, `services build` uses its build contexts, and
`infra/docker/.env` and the release overlay live in it. A private group per user, the Debian and
Ubuntu default, meets this even with their umask of `002`. Where the account's
group has other members, clone and pull with umask `022`.

For the same reason, keep the checkout at the selected release. The ops-agent's
startup log
(`pnpm openmapx services logs ops-agent`) and **Run diagnostics** under
Maintenance in the admin panel say when the checkout's built-in services differ
from the release's. The host `pnpm openmapx check` cannot: it runs the
checkout's own code and manifests.

Releases before the operations agent kept the Transitous pin in its own state
wrote an approved pin into the tracked `infra/docker/transitous.lock.json`. If
`git status` shows that file modified, restore it before pulling:

```bash
git checkout -- infra/docker/transitous.lock.json
```

The new release's pin then applies, and the auto-bump, if enabled, proposes a
newer one again through its canary. A leftover
`infra/docker/transitous.lock.proposed.json` is no longer read and can be
deleted.

The checkout has changed, but running containers still use their existing
images. Continue with release selection and replacement.

:::note[Read the release notes]
Before upgrading, read the release notes for breaking changes, including
a renamed environment variable, a new required secret, or a manifest change that
needs attention. OpenMapX is under active development, so an occasional manual
step between versions is expected.
:::

## 3. Re-render the compose stack

Review changes to `infra/docker/.env.example` and your selected service manifests,
then render the new configuration:

```bash
pnpm openmapx compose render
```

This applies a new configuration generation (compose file and hardlink plan)
from your current manifests, `infra/docker/.env` and the settings saved in the
admin panel. The output is deterministic, and re-rendering when nothing changed
preserves the same stack content. The update command also renders, but this
separate step lets you inspect configuration before replacement.

Run it as the checkout's owner. Releases before this one ran the stack's own
containers as uid 1000 unless `.env` said otherwise, and `app-api` always as
uid 1000. Now they all run as the deployment's user, `UID:GID` in `.env`, and
generated configuration has no fallback. Where `.env` sets neither, the first
render writes them from the checkout's owner, as does the operations agent when
a panel self-update starts it; explicit values are kept. A render refuses to
run as another uid, or to take the user from a checkout root owns.

Where the checkout's owner is uid 1000, nothing changes: the containers keep
their user, and `app-api` keeps using the volumes it wrote. Elsewhere:

- Files an earlier release's containers wrote as uid 1000 stay owned by it,
  also inside directories the operator owns. `pnpm openmapx check`, and
  **Run diagnostics** in the admin panel, name each path containers write that
  holds such files, with the one-time `sudo chown -R UID:GID …` that fixes it.
- `app-api` refuses a volume an earlier image created for uid 1000, and its
  startup log (`pnpm openmapx services logs app-api`) names the volume. Do not
  remove it: it holds the subject-export ciphertexts the database refers to and
  the runtime-recovery journal. Change its owner in place while `app-api` is
  stopped, with the volume name and ids from the log, for example:

  ```bash
  pnpm openmapx services stop app-api
  docker run --rm -v docker_openmapx-subject-exports:/v alpine chown -R 1001:1001 /v
  pnpm openmapx services start app-api
  ```

## 4. Resolve the complete release and replace containers

Inspect the locally selected release without contacting the registry:

```bash
pnpm openmapx compose release --status
```

This reports the selected release and its seven image pins. It does not inspect
running containers. Older overlays without selection metadata show an unknown
release identity while retaining their available image pins.

Running `pnpm openmapx compose release` prints the previous and candidate release,
then marks each image **changed**, **reused**, or **unknown** by comparing digests,
and writes the selected lockfile as the Compose overlay. An existing overlay
continues to apply even if release resolution is disabled with
`OPENMAPX_RELEASE=local`; the status command reports that explicitly.

Select the release explicitly, then replace the five running application
services. This operation can interrupt requests; it is not a database rollback
transaction:

```bash
pnpm openmapx compose release
pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner
```

`compose up`, `services start`, and `services update` refuse to run release
services when no overlay exists and the release manifest cannot be resolved.

The CLI validates all seven image pins and matching privacy evidence. Use it
instead of writing a partial overlay by hand. `main` is the automatic development pointer; `preview` is the latest deliberately published named prerelease. Exact versions or metadata digests pin a specific selection. A missing preview or pin fails without choosing main.

All seven development aliases are verified before the main manifest pointer advances. Individual aliases can move separately; use the manifest for coherent updates. Named publication promotes the selected image digests without rebuilding them and advances preview only after immutable GitHub publication is verified. See [Product releases](../developer/product-releases.md).

:::note[Admin updater and later service commands]
The admin system updater checks the configured channel and stores its exact candidate ID and digest.
A check compares the manifest's digests with the running images and downloads
nothing. Apply uses that checked candidate rather than resolving the channel again:
it pulls every digest-pinned image while the services keep running, then writes
`docker-compose.release.yml` atomically. A configuration change requires a fresh check.

When the release changes the ops-agent image or its privacy-backup helper pin,
the agent is updated first. It refuses while other agent operations are running,
and refuses new ones until the handoff finishes.
It records the handoff in `infra/docker/state/ops-agent/agent-handoff.json` and
starts a helper container from its own image, which:

1. writes the release overlay;
2. recreates only `ops-agent`;
3. waits up to three minutes for the new agent to be healthy and to run the pinned image and helper pin.

If the new agent does not start, the helper restores the previous overlay and
agent. The update then stops with **Host update required**, before any other
service changes. A new agent can fail to start when the release needs a newer
host checkout, for example for a new service manifest. In that case, run the
host commands shown in the panel.

The agent keeps its own state, the job journal, this handoff record, the
trusted-configuration queue it shares with `app-api` and its privacy-extraction
scratch, in `infra/docker/state/ops-agent/`. Releases before it kept them in
`infra/docker/data/`, which data-manager can write. The first agent of a newer
release imports from there only the jobs the previous agent left unfinished,
which then read as failed and needing recovery, and the handoff record only
while the helper replacing it is still running, without its previous overlay.
Finished job history is not carried over. The first configuration render, or
the new agent's start, moves the queue and the scratch directory; running
containers keep using them. When `infra/docker/data` is a filesystem of its own
(a separate dataset or disk), they can't be moved: the new locations start
empty and nothing is copied from the old ones, which data-manager could have
written. The agent reads its queue from the new location whatever its own
container mounts, so it meets `app-api` there once `app-api` has been replaced;
a request made in between, during the update, ends without being applied. The
old directories stay in `infra/docker/data/` for containers that still mount
them. Nothing needs doing by hand. An older agent started afterwards, for example by
selecting an earlier release, finds no job history.

The applied configuration, the service selection and the release state are in
that directory too: `configuration/`, `service-selection.json` and `releases/`
(the store, the evidence and `docker-compose.release.yml`). Releases before it
kept them in `infra/docker` itself (`.trusted-config-current`,
`.trusted-config-generations/`, `service-selection.json`, `.ops-agent-releases/`,
`.release-evidence/` and `docker-compose.release.yml`), where a checkout cloned
under a umask of `002` lets other accounts of its group write. The first
configuration render of the newer release, or its agent's start after a panel
self-update, copies them across:

- the applied configuration, with the selection its generation applied; the
  old `service-selection.json` is never read;
- the release manifests and pointers that are the deployment user's own files
  and pass the store's checks; anything else stays behind, named in the render's
  output or the agent's log;
- the release overlay, rendered again from the manifest it selected or, when
  `compose release` selected it and the store holds no manifest of it, from its
  own pins and evidence, once they give exactly its bytes again.

Nothing is moved, so this works when `infra/docker/data` is a filesystem of its
own. The old files stay as they were, for rolling back to an earlier release,
and are never read again. Until the newer agent runs with no self-update helper
left, every configuration writer also takes the earlier releases' lock in
`infra/docker`, so an earlier agent can't apply configuration at the same time.
A rollback restores an earlier agent with the configuration it left; anything
applied after the update is not carried back.

When the earlier agent left a release update unfinished
(`.ops-agent-releases/transaction.json`), the release state is not copied; the
render's output and the agent's log say so, and the next render or agent start
tries again once that agent has recovered the update.

While the release the earlier overlay selected has not come over, for that
reason or because the overlay could not be verified, no release is selected or
applied automatically: resolving one would replace the running release with
whatever is newest. `services update` and `services start` of the release's services, `compose up` and
`compose pull` refuse, and so do **Check for updates** and **Update** in the
admin panel, which report **Host update required**; the job log, the command
and **Run diagnostics** name the reason. To continue, either:

- let the earlier agent finish its update, then render again; or
- select a release explicitly with `pnpm openmapx compose release`, or clear the
  selection with `pnpm openmapx compose release --clear` to let the next start
  resolve one.

Rendering stops, with the reason, when:

- `infra/docker/.trusted-config-current` is not the deployment user's own: remove
  it, and the admin panel applies its saved settings again;
- `infra/docker/.env` is not the deployment user's own regular file, has more
  than one link, or its group or others can write it: run
  `chown "$(id -u)" infra/docker/.env && chmod 600 infra/docker/.env`.

The update then replaces API, web, data-manager and transitous-runner without
restarting their dependencies. If that step fails, those four services return
to the images they ran before the update; the verified new agent stays.
System status includes all five running application services.

API and CLI service lifecycle commands automatically include an
existing release overlay, so restarting or re-rendering the stack retains the
digest-pinned release. Keep the overlay with the deployment;
clear it with `pnpm openmapx compose release --clear` only when intentionally
removing the local selection.
Forks and mirrored registries select their own channel with
`OPENMAPX_RELEASE` and `OPENMAPX_RELEASE_MANIFEST_REPOSITORY` (see [Configuration](./configuration.md)).
`services update` preserves an existing release selection and stops before
container recreation if pulling that pinned release fails. Run `compose release`
first when deliberately selecting a newer release.
:::

For local-image workflows, explicit `OPENMAPX_RELEASE=local` disables automatic release resolution. It does
not remove or bypass an existing release overlay. Clear the local selection
explicitly:

```bash
pnpm openmapx compose release --clear
```

This idempotent command removes only `infra/docker/state/ops-agent/releases/docker-compose.release.yml`.
It makes no Docker calls and preserves running containers, `state/ops-agent/releases/evidence`
files that they may still mount, and `state/ops-agent/releases/store` manifests and recorded
running state. It refuses to clear while the release store is locked or an update
transaction awaits completion or recovery. `--clear` cannot be combined with
`--status`.

Clearing does not change your environment. If automatic resolution remains
enabled, the next start/update selects a release again. To use local images,
separately set `OPENMAPX_RELEASE=local` in your deployment environment.
With no overlay and resolution disabled, service updates pull
the manifest tags and may continue after pull failures to allow local images.
This is not an offline mode; Compose can still pull application images.
`compose pull` resolves a coherent release when no overlay exists and product services are included; it preserves existing deliberate pins. Exact helper pull failures never build a replacement image.

To reconcile the **entire** enabled stack while retaining the selected app
release, use the CLI:

```bash
pnpm openmapx compose pull
pnpm openmapx compose up
```

`compose up` refreshes the generated base file without overwriting the existing
release selection in `docker-compose.release.yml`. Heavy backend engines that did
not change are left running untouched.

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
database, and the migrator is **idempotent**; it skips migrations that are
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
Drizzle migrations are forward-only. There is no automatic down-migration. Once a
new `app-api` has migrated the database, rolling back to an older app image is not
supported unless you also restore the matching database backup. For upgrades
that cross a schema change, consider taking the optional backup in step 1 when
the deployment contains state you cannot readily recreate.
:::

## 6. Verify the upgrade

Check that every container came back healthy and the API is serving:

```bash
pnpm openmapx services status                  # container + health state for all services
curl --fail --silent --show-error https://maps.example.com/api/status
```

Replace `maps.example.com` with the actual domain. The CLI loads `.env` only into
its own process, so `${DOMAIN}` is not automatically available in your shell.
`compose release --status` reports local pins, while `services status` reports
container/health state; neither alone proves matching running digests. Inspect
the running image identity when verifying an exact release.

Then load the app in a browser and exercise the core paths; search, directions,
and any self-hosted engines you run. If a service is stuck, tail its logs:

```bash
pnpm openmapx services logs <id> --follow
```

For per-engine checks after an upgrade, see the verification steps in the
relevant guides; [routing engines](../guides/routing-engines.md),
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
supported, but every linked OAuth account will need to be re-linked afterwards;
Better Auth does not re-encrypt existing tokens under a new secret.

## Martin's own database login

Martin used to log in as the `postgres` superuser and publish every table it
could see, including the OpenConditions records and crowd reports kept in the
same database. It now serves only the traffic-flow tiles and logs in as
`openmapx_tiles`, which can read no table. If Martin is enabled, set its
password before rendering, then restart PostGIS so it applies it:

```bash
echo "MARTIN_DB_PASSWORD=$(openssl rand -hex 32)" >> infra/docker/.env
pnpm openmapx compose render
pnpm openmapx services update postgis --no-deps
pnpm openmapx services update martin
```

Without the password, rendering fails with `MARTIN_DB_PASSWORD must be set`.

## Reclaiming disk after an upgrade

Keep prior image digests and the matching database/configuration backup until
you have verified the release and completed your rollback window. The normal
prune command removes dangling images only:

```bash
docker image prune
```

It preserves images used by containers, but can remove untagged older images you
might want for rollback. It does not remove all unused tagged releases or clean
engine data. Avoid `docker system prune --volumes` as an upgrade cleanup step.

## Upgrading community extensions

Community extensions have their own versions and update workflow. Use
**Admin → Extensions** to preview and apply an update. The CLI also provides
`ext list`, `ext preview`, and `ext update`, including explicit confirmation of
reviewed host ports. Those commands need an authenticated admin API endpoint;
their default `http://localhost:3001` is not host-published by the managed
`app-api` manifest. A public HTTPS URL alone does not grant loopback admin
access. Follow [Community extensions](../administration/community-extensions.md)
for the supported access and confirmation workflow instead of assuming host CLI
invocation authenticates through the public proxy.

An accepted request queues work; check admin activity for completion before
retrying an interrupted request.

### Integrations installed before the agent recorded them

Releases before the operations agent owned `custom_integrations/` left
installed integrations without a record. On its first start after the upgrade,
`app-api` asks the agent to verify each integration an extension installed:
the agent downloads that extension's pinned artifact again, checks its
SHA-256, and records the integration only if the files on disk are exactly the
artifact's files. Until then, and for any integration that fails the check, the
agent leaves it out; its startup log and **Run diagnostics** name it, and why.
Nothing on disk is trusted as it is:

- an integration whose files differ from its artifact, or that was installed
  with `pnpm openmapx integrations install` (nothing records where it came
  from), needs to be installed again, from **Admin → Extensions** or with the
  same command;
- if the artifact could not be downloaded, the next `app-api` start tries again.

### After an interrupted extension update

The operations agent installs each service repository as a transaction: it
keeps the previous checkout, and what `app-api` needs to undo the change, until
the change is settled. The extension's database record is the commit point. If
`app-api` or the agent stops mid-update, the next `app-api` start, and every
later extension install or removal, settles what was left: a change the
database recorded is kept, and any other is rolled back, restoring the previous
checkout, service selection and running containers. The agent keeps its note
about a rolled-back change until the selection is restored, so a failure part
way through is finished by the next attempt. Integration installs are
transactions in the agent too, settled the same way.

If the agent is unreachable when `app-api` starts, `app-api` logs
`Interrupted extension changes could not be recovered yet` and serves normally;
the next extension job retries the recovery and fails, without changing
anything, until it succeeds. Do not delete `.repository-*`, `.backup-*` or
`.stage-*` entries under `services/.community/` by hand. The agent removes
leftover staging directories itself when it starts.

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
not as zero or "good" air quality.

The legacy Open-Meteo route
`GET /api/integrations/weather-open-meteo-air-quality/aqi` sends a 28 February 2027 sunset (`Sun, 28 Feb 2027 00:00:00 GMT`). Migrate point
consumers to `GET /api/integrations/air-quality/current`; the canonical response preserves model provenance,
the locally selected standard, nullable primary evidence/index fields, raw pollutant values, and explicit
partial or unavailable status. Do not translate a missing canonical primary into the legacy route's
normalised scalar. The compatibility response sends `Deprecation: true`, that route-specific `Sunset`, and a
`rel="successor-version"` link to the canonical current route.

## Where to go next

- [Preparing data](./preparing-data.md): refreshing OSM extracts, GTFS
  feeds, and rebuilding engine indexes (a separate cadence from code upgrades).
- [Managing services](./managing-services.md): restarting, rebuilding, and
  the staggered-startup order for heavy engines.
- [Configuration](./configuration.md): the `infra/docker/.env` reference, in
  case an upgrade introduces a new required variable.
