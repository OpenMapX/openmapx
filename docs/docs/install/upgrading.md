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
release, and the files those services mount, not the checkout's, and checks no
file permissions in it. The checkout must still be writable only by the
operator's account: `services build` uses its build contexts, and
`infra/docker/.env` and the agent's state live in it. A private group per user, the Debian and
Ubuntu default, meets this even with their umask of `002`. Where the account's
group has other members, clone and pull with umask `022`.

Keep the checkout at the selected release. The host CLI runs the checkout's
own code and manifests, so a host render reads the selected release's service
files from its operations-agent image and refuses while the checkout's built-in
services differ from that release's. It names the differing files and says
what to do: wait until the release of the checkout's commit is published and
use the coordinated update below, or check out the selected release's source
revision. A changed service file belongs in an
[override](./managing-services.md#service-file-overrides), which the refusal
ignores. `pnpm openmapx check` reports the same.

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
render on the host writes them from the checkout's owner; explicit values are
kept. The operations agent only reads them: until they are set, it reports
this when it starts, and the admin panel's renders and configuration changes
refuse, naming this render. A render refuses to run as another uid, or to take
the user from a checkout root owns.

Where the checkout's owner is uid 1000, nothing changes: the containers keep
their user, and `app-api` keeps using the volumes it wrote. Elsewhere:

- Files an earlier release's containers wrote as uid 1000 stay owned by it,
  also inside directories the operator owns, and Docker creates a missing bind
  source as root. `pnpm openmapx check`, and **Run diagnostics** in the admin
  panel, list each such entry that the stack's containers write, and print the
  one-time `sudo chown -R UID:GID …` for exactly those entries. What a service
  running as its image's own user writes (Valhalla's extracts, Overpass's
  database) is left out, and a directory that holds such data gets a
  non-recursive `chown` of itself only.
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

## 4. Check and apply the complete release

For an existing installation, use **Admin → System → Updates**. Check the
configured release and apply that exact candidate.
The coordinated producer preserves Data Manager ownership, drains active work,
retains its configuration decision and observes the original job across API and
agent replacement. Keep the backup option enabled.

The host CLI can drive the same public administrative producer when only the panel is
unavailable. If an agent/helper replacement or prerequisite actually failed, inspect
Activity and host diagnostics and resolve it first. Running the same candidate
through the CLI does not repair that failure and may create another backup. Run as the deployment/store owner from a current checkout. First
check the configured candidate without changing selected or running images:

```bash
pnpm openmapx compose release --status
pnpm openmapx compose release --check
```

The check pulls only the small metadata image, validates the seven immutable
image pins and privacy evidence, and caches the canonical manifest. It prints a
**Checked release** ID and a **Manifest digest**. It does not write the release
overlay, download application images or replace containers. Configuration changes
require inspection before checking again.

Create a private directory for the client receipt and an operator-provided
session file:

```bash
mkdir -p "$HOME/.local/state/openmapx"
chmod 700 "$HOME/.local/state/openmapx"
```

The session file must already contain only the signed-in full administrator's
Better Auth session cookie (`better-auth.session_token=…` or its `__Secure-`
variant), be owned by this user, have mode `0600`, and have one link. Obtain it
through your normal administrator session; the CLI never discovers browser
credentials, creates a session or uses local-admin authentication for an update.
Do not commit or publish it. The session needs at least two minutes remaining;
if it later expires, provide a fresh session for the same administrator and resume.

Replace the checked ID and digest below. The receipt path must be new:

```bash
pnpm openmapx system update \
  --release-id CHECKED_ID --digest MANIFEST_SHA256 \
  --session-file "$HOME/.local/state/openmapx/admin-session" \
  --receipt "$HOME/.local/state/openmapx/update.json"
```

The default API origin is `https://DOMAIN`; `--api-origin https://maps.example.org`
sets it explicitly. Credentials are sent only to that exact HTTPS origin, with
redirects refused. `--allow-loopback-http` is only for explicit local development.

By default, the command checks for other maintenance work, creates a named backup and waits
for its matching completion. It then previews a release-only change, verifies
that configuration, origins, sources and the five application targets are exactly
as expected, and applies through the real administrator's public API. The server's
writer and coordinator checks remain authoritative. A refused or incomplete
outcome is never reported as a successful update.

The release's images are downloaded before the instance enters maintenance,
and images already on the host with the pinned digest are not downloaded again.
The admin panel's guarded update downloads them after the backup and before it
creates the preview. The CLI workflow above creates the preview first and
downloads when the apply job starts. A preview stays valid for ten minutes and
that lifetime is not extended: if the download takes longer, the job fails right
after the download, before maintenance begins, and tells you to create a new
preview and apply again; with the CLI that means a new receipt, as described
below. Rerunning is quick because the images are already on the host. If the registry is unreachable or an image cannot be verified, the
update also fails at this point: every service keeps running the old release and
no maintenance state is held. Once maintenance begins, the update only checks the
frozen release and the pinned images already on the host and never contacts the
registry.

To skip the backup, add `--no-backup`, matching the admin panel's backup choice.
The receipt retains this choice; use the same flag when resuming that update.
Without the flag, the command still requires a completed backup before applying.

Each request's key and body are retained before sending. After a transport error,
API restart or observation timeout, resume the original receipt:

```bash
pnpm openmapx system update \
  --release-id CHECKED_ID --digest MANIFEST_SHA256 \
  --session-file "$HOME/.local/state/openmapx/admin-session" \
  --receipt "$HOME/.local/state/openmapx/update.json" --resume
```

An accepted job is observed by its original ID; unknown POST outcomes replay only
the original key and body. A definite refusal stops. An expired preview requires a
new receipt (and a new backup unless skipped), rather than silently reviewing a different candidate.
Activity shows `platform.apply` for this workflow. After completion, verify the
actual running image digests and health; selected pins alone do not prove a
running deployment. The session file is preserved so you can decide when to
remove it.

### Bootstrap and recovery selection

Bare `pnpm openmapx compose release` is for a clean installation without an
existing Data Manager, or restoring the exact immutable pin its container already
uses. It refuses a different pin, ambiguous/unavailable Docker observations, or
an active transaction. The container's recorded image reference and actual image
identity must both match. It never recreates containers.

Do not select a new pin and then run `services update data-manager`. Host service
lifecycle commands preserve an existing selection; a Data Manager update needs
the coordinated producer above. Updating other services individually does not
complete an application release and API migrations move forward only.

For bootstrap, the CLI validates all seven image pins and matching privacy
evidence before selecting. `main` is the development pointer; `preview` is the
latest deliberately published named prerelease. Exact versions or metadata
image digests pin a particular selection. A missing preview or pin fails without
choosing main. See [Product releases](../developer/product-releases.md).

A legacy transaction or unconsumed handoff must finish or recover before a new
update. Preserve those records and inspect Activity and diagnostics; do not delete
writer guards or reinterpret a selected overlay as proof of completion.

### Recovering a refused host service update

A standalone host `services start` or `services update` that fails releases its
service locks as it exits, once its failure is recorded under
`infra/docker/data/ops-agent/lifecycle/<operation-key>.json`, so you can fix the
cause and run the command again. Containers that already started are left running;
the retry converges on them. The locks stay in place when the failure could not be
recorded, or when a hardlink request had already been issued to Data Manager. A
later command that finds a service locked names the operation holding it.

When the command failed at the hardlink step itself, `services recover-update`
below may release the locks. When the hardlink request had already completed and a
later step failed, such as a Compose start that hit a port conflict,
`recover-update` refuses with `Original failure before hardlink completion required`
and no automated release exists yet: those services stay locked. Keep the original
records and do not delete guards.

A read-only traffic inspection failure is terminal. Data Manager also settles an
interrupted legacy data job by observation, at startup and then every minute. It
looks up each host operation the job recorded by its operation key, and it never
resubmits or cancels one. A job that recorded no operation, or whose recorded
operations have all finished, becomes `error` and stops blocking later data jobs.
A job with an operation that is still running stays interrupted. So does a job
whose operations the ops-agent cannot answer for, for example while the agent is
down; it clears on the first pass after the agent answers. When the agent
restarted mid-operation it reports the operation as failed with a
recovery-required outcome, which does not prove the host effect ended, so the job
stays interrupted until the operation's deadline plus 30 seconds has passed.

For a standalone host `services start` or `services update` that failed at
hardlinks after committing its configuration, retain its original operation key
from `infra/docker/data/ops-agent/lifecycle/<operation-key>.json`. Once the
original deadline has expired, the installation owner can run:

```bash
pnpm openmapx services recover-update --operation-key ORIGINAL_OPERATION_KEY
```

This requires the updated CLI, Data Manager and ops-agent. It verifies the original signed
failure and asks Data Manager to attest, under its database admission lock, that
the original child has no SQL admission or private adoption record. Only then
can it revoke that unused grant and release the original service locks. A missing
file or HTTP 404 alone is insufficient. Adopted or uncertain work still refuses.
Keep all original records when it refuses; do not delete guards.

Recovery preserves the failed receipt and committed configuration. It neither
replays the child nor changes containers, and does not make a backup. After
successful recovery, use **System → Updates** or the checked `system update`
workflow above for the next application release. An already blocked installation
may require a separately supervised upgrade before these fixes can run; changing
the checkout alone does not update its running Data Manager.

Rendering stops, with the reason, when `infra/docker/.env` is not the deployment
user's own regular file, has more than one link, or its group or others can write
it: run `chown "$(id -u)" infra/docker/.env && chmod 600 infra/docker/.env`.

The retained configuration helper replaces the selected application services
without restarting unrelated dependencies. A failure can require reconciliation;
inspect the original Activity job and preserve its recovery records. Do not infer
a rollback from a disconnected API or an unchanged release-status field.
System status includes all five application services.

API and CLI service lifecycle commands automatically include an
existing release overlay, so restarting or re-rendering the stack retains the
digest-pinned release. Keep the overlay with the deployment;
clear it with `pnpm openmapx compose release --clear` only when intentionally
removing the local selection.
Forks and mirrored registries select their own channel with
`OPENMAPX_RELEASE` and `OPENMAPX_RELEASE_MANIFEST_REPOSITORY` (see [Configuration](./configuration.md)).
`services update` preserves an existing release selection and stops before
container recreation if pulling that pinned release fails. Use System → Updates or the authenticated `system update` workflow
when deliberately applying a newer release.

For local-image workflows, explicit `OPENMAPX_RELEASE=local` disables automatic release resolution. It does
not remove or bypass an existing release overlay. Clear the local selection
explicitly:

```bash
pnpm openmapx compose release --clear
```

This idempotent command removes only `infra/docker/state/ops-agent/releases/docker-compose.release.yml`.
It inspects existing Data Manager containers and refuses to clear a valid overlay
that a matching coordinator still uses. Clearing mismatched or malformed state is
only a recovery action; Docker ambiguity or observation failure refuses. It preserves running containers, `state/ops-agent/releases/evidence`
files that they may still mount, and `state/ops-agent/releases/store` manifests and recorded
running state. It refuses to clear while the release store is locked or an update
transaction awaits completion or recovery. `--clear` cannot be combined with
`--status` or `--check`.

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

### Closing an expired application-update preparation

Older Data Manager releases could adopt an application's maintenance grant and
then refuse admission because their registered service inventory was incomplete.
Activity can consequently remain at preparation with `recovery_required`, even
though the previous application containers are still healthy.

After installing the corrected API, ops-agent and Data Manager together, cancel
the **original** job in Activity with a full administrator session. Once its
original deadline has expired, cancellation can settle this specific case. The
receiver checks its locked database and private admission records, while the
agent checks the original candidate, frozen phases and complete ownership tree.
An admitted receiver, changed source or unavailable evidence keeps it pending.

Verified recovery preserves the original failed receipt, releases its ownership
and discards its verified inert configuration candidate before finishing the
application job as **failed**, with the cancellation request retained. It does
not resume the expired update, replace containers or make a
backup. Start a fresh checked update afterward; use `--no-backup` for CLI updates
and their resumes when that is your selected policy, or disable the panel's
backup option.

This recovery requires the upgraded running control services; updating the
checkout alone is insufficient. An already blocked installation may need a
separately supervised installation first. Older control images do not understand
the new negative-admission evidence, so do not downgrade them after recovery.
The standalone `services recover-update` command above does not recover an
API-owned application job. Preserve the original records; do not delete locks
or replay its preparation grant.

An earlier API could finish this recovery as failed while leaving its candidate
marked prepared, causing the next update to report `Configuration writer
unavailable`. The corrected API automatically rejoins only the original verified
negative recovery and completes its candidate cleanup. Its existing cancellation,
canonical copy and recovery proof must still match; cleanup rechecks the original
NoGuard closure and refuses a published or claimed candidate. Unavailable or
changed evidence keeps the candidate fenced. Do not clear its database flag or
start another copy of the old update.

## 5. Database migrations apply automatically

OpenMapX does not have a separate "run migrations" command for a self-host
upgrade. When `services update` replaces `app-api` (step 4), it first stops the
old `app-api` and applies the new image's pending Drizzle migrations in a one-off
container. Their output is part of the update's output. Only then does it start
the new containers. The migrator is **idempotent**; it skips migrations that are
already applied and only runs the new ones.

`app-api` also applies pending migrations whenever it starts, so a container
started any other way catches up too. After the update's migration step there
are none left. You can confirm it ran cleanly in the API logs:

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

### While a migration runs

The migration step logs `Applying N database migrations` with their names before
it starts. The API is unavailable until it finishes and the new containers have
started. A migration that changes many rows can take a while. To follow it:

- Every minute, it logs `Still applying database migrations` with the statement
  it is running and for how long. If that statement is waiting for a lock another
  database session holds, it logs that instead.
- In PostgreSQL the migration's session is named `openmapx-api-migrations`.
  From `psql` in the `postgis` container, connected to the `openmapx` database:

  ```sql
  SELECT state, wait_event_type, now() - query_start AS running, left(query, 80)
  FROM pg_stat_activity WHERE application_name = 'openmapx-api-migrations';
  ```

Let a migration that is making progress finish. All pending migrations run in
one transaction, so stopping the update rolls every one of them back. The
previous `app-api` then starts again, nothing is replaced, and the next update
repeats the migrations from the beginning. A migration that fails does the same.

An update from the admin panel stops after 30 minutes, including its backup and
image pull, and its migration with it. Apply a release whose migration needs
longer from the host with `pnpm openmapx services update`, which has no time
limit.

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

## Rolling back

Rollback needs a recovery decision. Image selection does not reverse database
migrations or a committed configuration change. Preserve the previous coherent
manifest and matching database/configuration backups. If a rollback is compatible,
set `OPENMAPX_RELEASE` to its exact metadata digest, check it with `--check` and
review it through the same coordinated workflow. There is no positional
`compose release <release>` command. Bare selection is permitted only for bootstrap
or restoring the exact Data Manager pin already in use.

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
`.stage-*` entries in `infra/docker/state/ops-agent/community/` by hand. The
agent removes leftover staging directories itself when it starts.

## Where to go next

- [Preparing data](./preparing-data.md): refreshing OSM extracts, GTFS
  feeds, and rebuilding engine indexes (a separate cadence from code upgrades).
- [Managing services](./managing-services.md): restarting, rebuilding, and
  the staggered-startup order for heavy engines.
- [Configuration](./configuration.md): the `infra/docker/.env` reference, in
  case an upgrade introduces a new required variable.
