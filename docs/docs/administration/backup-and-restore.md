---
title: Backup & restore
description: Create and inspect recovery snapshots, protect keys and erasure history, and restore service state.
sidebar_position: 7
---

# Backup & restore

Use `pnpm openmapx backup` from the deployment checkout, or
**System → Backups** with a full administrator account. You need the generated
Compose configuration, Docker access on the host or through the operations agent,
and enough disk for the selected volumes.

Backups contain personal data, credentials and service state. Archives are
compressed, not automatically encrypted. Restrict access, encrypt off-host
copies and test recovery in an isolated deployment before depending on them.

## What gets backed up

Every service declares its volumes in its manifest, and each volume carries a
`backup` flag. The backup tooling walks the enabled services and snapshots only
the volumes flagged `backup: true`. Common built-in targets are:

- **`postgis`**: the PostgreSQL/PostGIS database. User
  accounts and sessions, saved places, vehicle and parking state, share payloads,
  Timeline connection metadata, the audit log, all admin and integration
  configuration, and imported place data live here. It is captured as a streamed
  `pg_dump` archive in PostgreSQL's compressed custom format while the database
  stays running.
- **`redis`**: the Valkey (Redis-compatible) cache. Holds the transit registry
  snapshot and assorted app caches. Captured as a gzipped `tar` of the volume.
- **`traefik`**: the reverse proxy's ACME state, i.e. the Let's Encrypt
  certificates Traefik obtained for your domain. Captured as a gzipped `tar`.

When managed Timeline services are enabled, the backup also includes
`dawarich-postgis`'s database and `dawarich-app`'s declared storage/public/watched
volumes. Community services can declare additional backup-enabled named volumes.
Inspect the resulting manifest instead of assuming the three core services are
the complete inventory.

Database dumps stream while the database stays running. For
`tar`-mode volumes, the producing service stops during the copy and restarts
afterward. Plan for that interruption. Separate services are captured in
sequence; this is not a transactionally consistent snapshot of the whole stack.

Each snapshot is stored under `infra/docker/backups/<name>/` with a format-2
`manifest.json`. It records service/platform versions, archive sizes, SHA-256
digests and mode-specific metadata. Tar entries retain the resolved Docker
volume name; database entries retain the database/user target. On another host
or Compose project, verify that these targets match the deployment you intend to
restore. A recorded volume name is not an automatic migration to a newly named
volume.

## What gets skipped, and why

Region-derived indexes are excluded when their
manifests set `backup: false`, or they're bind-mounted data trees the tooling
never touches:

- Nominatim's geocoding database
- Elasticsearch (the Pelias backend)
- the Valhalla, MOTIS, Photon, TileServer, and Overpass data directories

Rebuild those indexes from retained source data using
[Preparing data](../install/preparing-data.md). Preserve operator-only sources,
transit manifests and configuration separately when they cannot be reacquired.
Named-volume backups do not capture arbitrary bind-mounted data.

:::caution[Save configuration and recovery material separately]

Snapshots do not contain `infra/docker/.env`, host secret files, the external
erasure journal or service-selection/configuration generations.
Protect recovery copies of the configuration actually used by your deployment,
including generated credentials and any external secret manager records.
`BETTER_AUTH_SECRET` protects authentication material; `OPENMAPX_SECRETS_KEY`
is required to decrypt vault credentials. A database archive alone cannot
reconstruct these keys or a compatible host setup.

For erasure-safe restore, retain both
`infra/docker/data/erasure/journal.jsonl` and
`infra/docker/secrets/erasure-journal-key`. Keep recovery copies current as
accounts are erased. Follow [User erasure operations](./user-erasure.md) for
permissions and journal handling.

:::

Copy snapshot directories and the required recovery material off the deployment
host. A copy on the same disk does not protect against disk loss. Verify the
copy's integrity, restrict access and apply the same retention policy off-host.
The local scheduler cannot remove copies in storage it does not control.

:::warning[Backups retain user data independently]
Ordinary synchronized content is not end-to-end encrypted. A database snapshot
contains the server-readable user fields and encrypted credentials that existed
when it was created. Deleting an account or individual row from the live
database does not rewrite existing snapshots.

Local backups are automatically removed after `BACKUP_RETENTION_DAYS` (30 by
default), and an expired backup is refused even if its directory was copied back.
New snapshots also carry a portable `expiresAt` ceiling. Increasing retention
applies to new snapshots; it cannot make an old snapshot restorable again.
Before a UI-managed policy change, legacy manifests acquire their existing expiry
under the backup-store lock. A shorter policy lowers existing ceilings. If a later
configuration apply fails, the stricter expiry remains. When changing host-owned
environment values directly, run pruning under the old policy before increasing
it; the application cannot infer an earlier environment value after replacement.
Database restores replay the external pseudonymous erasure journal before they
finish, so an account deleted after the snapshot is deleted again. Restrict and
encrypt every local and off-host copy, and apply the same expiry to off-host
copies. The local scheduler cannot delete objects in storage it does not control. The
[user-data trust model](../developer/user-data-trust-model.md) describes the
boundaries in detail.
:::

## Personal data in backups

Backups are kept for up to `BACKUP_RETENTION_DAYS` and are used only to recover
from failure. They are not searched automatically for an access request, and no
per-person extraction runs from them. The privacy page and the export's
response report state this to the people whose data you hold.

The operator handles a person's request for data held in backups manually.
Requests arrive through the published data-request contact, and the case keeps
a retained-backup source task that the operator resolves and records. Never
restore a backup into production to answer such a request.

### Manual backup export for a privacy request

Run these steps from the OpenMapX checkout on the deployment host. They
restore one snapshot into a throwaway database that has no network, export the
person from it, and remove everything again. Never restore into production,
and never mount production secrets, the erasure journal or its key into the
scratch container. The export reaches the scratch database through a bind-mounted
Unix socket, which needs a Linux host running Docker Engine; Docker Desktop on
macOS or Windows cannot connect through such a socket.

1. **List the backups.** `pnpm openmapx backup list` prints each snapshot
   under `infra/docker/backups/` with its creation time.
2. **Pick a snapshot within retention and check it.** Choose a snapshot whose
   manifest `expiresAt` has not passed. Its `manifest.json` names each dump
   file (`postgis__<volume>.dump` for the OpenMapX database) with its size
   and `sha256`. Compare the digest before using the file:

   ```bash
   SNAPSHOT=infra/docker/backups/<name>
   sha256sum "$SNAPSHOT"/postgis__*.dump   # must equal the manifest sha256
   ```

3. **Start the scratch database.** Use the PostGIS image that production
   runs. Its name, tag and digest are pinned in `services/postgis/service.json`
   under `container.image`, `container.tag` and `container.digest`; read them
   from there rather than copying a digest from this page:

   ```bash
   POSTGIS_IMAGE=$(node -p 'const c = require("./services/postgis/service.json").container; `${c.image}:${c.tag}@${c.digest}`')
   SCRATCH=$(mktemp -d /srv/privacy-scratch.XXXXXX)   # mode 0700, yours only
   mkdir "$SCRATCH/socket"
   docker run -d --name openmapx-privacy-scratch --network none \
     -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
     -v openmapx-privacy-scratch-data:/var/lib/postgresql \
     -v "$PWD/$SNAPSHOT":/snapshot:ro \
     -v "$SCRATCH/socket":/var/run/postgresql \
     "$POSTGIS_IMAGE"
   ```

   The image's entrypoint makes the socket directory world-writable, and local
   socket connections need no password. The scratch directory created by
   `mktemp -d` is what keeps the socket private, so do not loosen its mode.
   The password is only there because the entrypoint refuses to start without
   one; nothing uses it.

4. **Restore the dump into a fresh database.** The entrypoint first runs a
   temporary server that listens only on the socket, then restarts. Wait for
   the final server on the container's loopback address, which still exists
   with `--network none`. Then restore the OpenMapX dump into an empty
   database. A database created by the image already holds the PostGIS
   extension schemas that the dump creates again, and the restore would stop
   on them. The scratch restore gives every object to the superuser, so it
   needs none of the deployment's roles.

   ```bash
   until docker exec openmapx-privacy-scratch pg_isready -q -h 127.0.0.1 -U postgres; do sleep 2; done
   docker exec openmapx-privacy-scratch dropdb -U postgres --if-exists openmapx
   docker exec openmapx-privacy-scratch createdb -U postgres openmapx
   docker exec openmapx-privacy-scratch sh -c \
     'pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d openmapx /snapshot/postgis__*.dump'
   ```

   Unlike `pnpm openmapx backup restore`, which restores each object as the
   role that owns it, this restore runs every role's check constraints and
   index expressions as the scratch database's superuser. Keep the container
   without network, secrets or other mounts, and remove it afterwards.

   A managed Dawarich timeline lives in the separate `dawarich-postgis__*`
   dump; check it the same way in its own scratch container if the person had
   a connected timeline.

5. **Export the person from the scratch database.** The script runs the same
   streaming export as the self-service download, against the scratch socket
   only, and writes the ZIP to a file. It needs no secrets: it never reads
   `DATABASE_URL` or the secrets key, and it does not contact the ops agent.

   The response report names the controller. The script reads each legal fact
   from its `LEGAL_*` environment variable when that is set, and otherwise
   from the `system_settings` table of the restored snapshot, which holds the
   facts as they were when the backup was taken. To report the current facts,
   pass them as plain values on the command line, copied from the legal
   settings in the administration area. Do not source the production
   environment or secrets files to get them. `BACKUP_RETENTION_DAYS` should
   match production; it defaults to 30.

   ```bash
   LEGAL_NAME="Example Maps GmbH" LEGAL_STREET="Example Street 1" \
   LEGAL_POSTAL_CODE="10115" LEGAL_CITY="Berlin" LEGAL_COUNTRY="Germany" \
   LEGAL_DATA_REQUEST_EMAIL="privacy@example.org" \
   LEGAL_DEPLOYMENT_JURISDICTION="DE-BE" LEGAL_SUPERVISORY_AUTHORITY="<authority>" \
   BACKUP_RETENTION_DAYS=30 \
   pnpm --filter @openmapx/api exec tsx scripts/privacy/export-from-database.ts \
     --socket-dir "$SCRATCH/socket" --database openmapx \
     --subject <account id> --case <privacy case id> --out "$SCRATCH/backup-export.zip"
   ```

   Leave out the `LEGAL_*` variables to use the snapshot's facts instead. The
   script stops with `PRIVACY_CONFIGURATION_INCOMPLETE` when a required fact is
   missing from both. The report inside the archive lists sources the scratch
   database could not answer, such as the managed timeline, for you to review.

6. **Remove the container, its volume and the scratch files** once the
   archive is delivered through the agreed channel:

   ```bash
   docker rm -f openmapx-privacy-scratch
   docker volume rm openmapx-privacy-scratch-data
   rm -rf "$SCRATCH"
   ```

7. **Record the outcome on the case.** Resolve the `backup-retained-copies`
   task in **Privacy requests** with a reason code that names the snapshot
   checked, and complete the request when every task is resolved.

## Creating a backup

From the repo root, the CLI snapshots every backup-enabled volume in one command:

```bash
pnpm openmapx backup create                    # timestamp-named snapshot
pnpm openmapx backup create --name weekly      # explicit name
```

With no `--name` the snapshot is named after the current timestamp. A custom name
may contain letters, numbers, dots, dashes, and underscores. Creating a snapshot
whose directory already exists is refused rather than overwriting it. After a
successful snapshot, the CLI prunes backups older than `BACKUP_RETENTION_DAYS`;
the operations agent also performs that prune at startup and daily.

The same actions are available without a shell, on **System → Backups** in the admin panel
([Admin panel](./admin-panel.md) maps the rest of the surface). Enter an optional
name, click **Create Backup**, and the operation runs as a background job. The
table lists every snapshot with its creation time, the platform version, the
service and volume counts, and total size; it refreshes on its own and links
straight to **Activity** so you can watch the job and read its log (see
[Monitoring](./monitoring.md)). Because the CLI and the admin UI both write to
`infra/docker/backups/`, a snapshot made one way shows up in the other.

Cancellation stops the CLI's artifact writers before removing an incomplete
snapshot. A PostgreSQL dump is supervised inside its database container, and a
volume archive has its own helper container with Docker init. A clean Docker
client exit alone does not confirm a dump completed. Community `pg_dump` images
must include Bash, and the Docker engine must provide `docker-init`. Installation
paths containing commas, quotes or newlines are refused for volume backups
because Docker's bind-mount option cannot represent them safely here.

An ordinary failure restarts stopped services within the original CLI deadline.
Cancellation instead limits cleanup to the process-group shutdown window.
Services can remain stopped if the authority
deadline expires or Docker's final SIGKILL interrupts rollback. Repeated terminal
signals can also interrupt cleanup subprocesses. Inspect service status before
restarting services through the normal admin or CLI workflow. If an archive
writer's removal cannot be confirmed, its incomplete directory is retained and
appears as an invalid backup. When the CLI can report this failure, its diagnostic
gives the unique `openmapx.backup-writer` label. After a hard kill, inspect helpers
with that label key and match their `/backup` mount to the partial directory. A delayed container creation can also leave an
inactive labelled helper holding its source volume. Confirm that helper is
inactive or removed before deleting retained partial files. Do not remove the
source volume. PostgreSQL backend cancellation depends on the dump's cancel
request reaching the server; a force-killed dump can leave a backend until it
detects the closed connection.

A published backup is retained if service restart fails or cancellation arrives
after publication. In the latter case the CLI exits 130 and the operation can
show failed or unknown even though the backup remains listed. A publication
error after the manifest rename also preserves the directory for inspection.
These checks do not add a crash-durability guarantee to archive data files.

**Preview expired backups** shows the current policy and its host/database source,
the eligible snapshots and their size, retained count, and unreadable expiry metadata.
The preview does not modify archives. Type **PRUNE EXPIRED BACKUPS** to queue deletion.
It expires after 15 minutes, and a changed policy, newly created backup, or replaced
archive requires a fresh preview. Only the original listed set is deleted; later
eligibility does not enlarge it. A lost response can be retried with the same
retained request. **Edit backup retention policy** opens the existing source-aware
platform setting, where host ownership can be explicitly adopted or restored.
Pruning and restore both honor the earlier of the current policy and stored expiry.

## Listing and inspecting backups

```bash
pnpm openmapx backup list
```

This prints every snapshot under `infra/docker/backups/` with its creation time,
service and volume counts, and size. A directory with a missing, malformed or unsupported manifest is flagged as **corrupt** in the list and admin table. A corrupt entry
can't be restored (the CLI errors, and the admin API returns a conflict), but you
can still delete it to clean up.

## Restoring

Restoring overwrites the current contents of the targeted volumes with what's in
the snapshot, so treat it as a destructive operation.

```bash
pnpm openmapx backup list                       # find the snapshot name
pnpm openmapx backup restore weekly             # restore everything in it
```

For an OpenMapX database, four checks happen before any data is touched: the
backup must be within `BACKUP_RETENTION_DAYS`; the erasure journal and its key
must be readable and the journal must be cryptographically bound to that key;
the backup must not predate the journal's current coverage floor; and
the platform version in the snapshot's manifest must be compatible. A **major-version**
mismatch is refused outright, while a minor mismatch prints a warning and
proceeds. If a targeted tar-volume service is running, or if `app-api` is serving
the OpenMapX database being restored, the restore refuses unless you opt in:

```bash
pnpm openmapx backup restore weekly --stop-running
```

With `--stop-running`, the CLI stops the required tar targets and dependent API and restarts them after a successful restore. The database server stays running because restoring the
dump needs it. For an OpenMapX database restore, the CLI also
stops `app-api` before the database is replaced and restarts it only after the
erasure journal has been replayed. If restore or replay fails, the API remains
stopped so it cannot expose resurrected account data.

Database dumps keep each object's owner and grants. A restore drops and
recreates the database, gives it the owner and database-level grants the live
database had, then restores the dump. The API therefore keeps its schemas and
the right to create them, data-manager keeps its own tables and schemas, and
the API can still read them.

Each object is restored by a session that logs in as the role owning it,
over the database container's local socket. A table's check constraints,
defaults, generated columns and index expressions, which the restore
evaluates, therefore run with their owner's rights and never as the
superuser. The superuser restores only schemas, extensions and its own
objects, and objects of roles that cannot log in, such as the tile
function's owner. The restore's other superuser steps search only the
system catalogs; the erasure replay and the closing of restored jobs connect
as `openmapx_api`, which owns those tables.

The roles themselves belong to the PostgreSQL server, not to any database,
and are not in the dump. PostGIS creates them each time it starts, so to
restore onto a new host or an empty volume, render and start `postgis` from
this checkout first, then restore. A community service's own role (see
[Community extensions](./community-extensions.md)) must likewise exist, and
be able to log in over that socket, before its database is restored.

Backups taken before this release are plain SQL files (`.sql.gz`), which
only a superuser session can load. The CLI still restores them into other
services' databases, but refuses them for the OpenMapX database, whose
tables this release's roles must own.

When it restores the OpenMapX database, the CLI also closes every job the
snapshot still shows as in progress, before the API restarts. That covers queued,
running and cancel-pending admin jobs; data-manager executions that are queued,
running, cancel-pending, interrupted without finishing, of unknown publication
outcome or holding unsettled child operations; and offline packages still being
prepared. They become failed with the reason "restored from backup", because the
process that owned them no longer exists and resuming them could repeat host
changes. An unknown publication is recorded as not started and the unsettled
child records are dropped, so the data manager's recovery pass cannot reopen the
job. Finished jobs are untouched. If this step fails, the API stays stopped.

After the selected data has been restored and before restarting the API, the
CLI revalidates the journal/key pair and HMAC-matches restored
user IDs against `infra/docker/data/erasure/journal.jsonl` and removes every
match. The journal contains neither raw user IDs nor email addresses. The journal
and `infra/docker/secrets/erasure-journal-key` are deliberately outside the
PostgreSQL backup. Disaster-recovery copies must include both. Do not rotate or
discard the key while a backup that could contain an erased account exists;
without the matching key, OpenMapX refuses the restore rather than risk
resurrecting data. Only the current bound journal and verified backup formats
are accepted; there is no legacy conversion or recovery workflow.
Compaction advances the coverage floor when old erasure requests are removed,
so later increases in backup retention do not re-enable unsafe older backups.

To restore only part of a snapshot, name the services:

```bash
pnpm openmapx backup restore weekly --services postgis --stop-running
```

The admin UI mirrors all of this. Click the restore action on a row, optionally
type a comma-separated list of service IDs to limit the scope, toggle **stop
running target services** if needed, and confirm. The restore runs as a
background job you can follow in **Activity**. A separate delete action removes a
snapshot directory entirely and cannot be undone.

:::note[Schema and version compatibility]

The API applies pending Drizzle migrations at boot, but protected database replay
runs before it resumes. The restored schema must already satisfy the current
erasure-replay contract. A compatible platform major version is only one check;
it does not guarantee that every older schema can be restored. Unsupported
schemas fail restore and leave the API stopped. There is no legacy-format
conversion or automatic recovery bypass.

:::

## Back up before you upgrade

A pre-update backup is recommended because database migrations run on API
startup and are forward-only. Choose a unique name, save configuration and
recovery keys separately, then verify the snapshot before updating:

```bash
pnpm openmapx backup create --name pre-upgrade-20261023
pnpm openmapx backup list
```

The update dialog in **System → Updates** offers a database backup by default and permits
opting out. Restoring data after an upgrade also requires a compatible runtime
and schema; merely switching image tags does not reverse migrations. Follow
[Upgrading](../install/upgrading.md) and test the recovery sequence before a
production change.

## A reasonable routine

A practical baseline for a self-hosted instance:

- Take a snapshot before every upgrade, named for what you're about to do.
- Take regular snapshots at the frequency your recovery policy requires, and copy the snapshot directory and required configuration/journal/key recovery material
  off the host.
- Verify the automatic policy with `backup prune --retention-days 30`; use
  `backup delete <name>` for an exceptional early removal.
- Test a restore in an isolated deployment, including erasure replay, API startup and required external services. Plan to rebuild excluded indexes as covered in
  [Preparing data](../install/preparing-data.md).

## Where to go next

Follow [Upgrading](../install/upgrading.md) for release changes,
[Preparing data](../install/preparing-data.md) for excluded indexes and
[Monitoring](./monitoring.md) for background-job results.
