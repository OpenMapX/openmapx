---
title: Backup & restore
description: Create and inspect recovery snapshots, protect keys and erasure history, and restore service state.
sidebar_position: 7
---

# Backup & restore

Use `pnpm openmapx backup` from the deployment checkout, or
**Services → Backups** with a full administrator account. You need the generated
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
  configuration, and imported place data live here. It is captured with a streamed `pg_dump` piped through gzip
  while the database stays running.
- **`redis`**: the Valkey (Redis-compatible) cache. Holds the transit registry
  snapshot and assorted app caches. Captured as a gzipped `tar` of the volume.
- **`traefik`**: the reverse proxy's ACME state, i.e. the Let's Encrypt
  certificates Traefik obtained for your domain. Captured as a gzipped `tar`.

When managed Timeline services are enabled, the backup also includes
`dawarich-postgis`'s database and `dawarich-app`'s declared storage/public/watched
volumes. Community services can declare additional backup-enabled named volumes.
Inspect the resulting manifest instead of assuming the three core services are
the complete inventory.

Database dumps stream through gzip while the database stays running. For
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
erasure journal, service-selection/configuration generations or release evidence.
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

Export-storage keys require separately protected recovery handling. Keep the
private export volume excluded from ordinary backups; including it would defeat
the workflow's retention boundary. See
[Export-key provisioning and rotation](./data-subject-requests.md#export-key-provisioning-and-rotation).

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
Database restores replay the external pseudonymous erasure journal before they
finish, so an account deleted after the snapshot is deleted again. Restrict and
encrypt every local and off-host copy, and apply the same expiry to off-host
copies. The local scheduler cannot delete objects in storage it does not control. The
[user-data trust model](../developer/user-data-trust-model.md) describes the
boundaries in detail.
:::

## Privacy access review

Backups are not automatically searched for every Article 15 request. The
privacy queue exposes a trusted, path-free inventory and records a review for
each snapshot family. A reviewer compares its creation time with the request
cutoff and live snapshot, then records `no_material_difference`, `extract`, or
an honest unavailable reason. Unsupported manifests and changed files
are never extracted.

An approved extraction uses fixed, version-compatible collectors in an isolated
scratch environment without external network access. It never restores into production or
mounts production volumes, secrets, the erasure-journal key, artifact keys or
the Docker socket. The source part is streamed directly into the encrypted
case artifact and the scratch database, containers, network and volumes are
cleaned through monitored success, failure, timeout and restart paths. Cleanup
can fail; investigate it instead of assuming physical removal. Readiness requires
healthy cleanup, backup-review capability and current independent approvals.
Individual case review tasks must also be resolved before assembly.

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

The same actions are available without a shell, on the **Backups** page under
[Services](./services-administration.md) in the admin panel
([Admin panel](./admin-panel.md) maps the rest of the surface). Enter an optional
name, click **Create Backup**, and the operation runs as a background job. The
table lists every snapshot with its creation time, the platform version, the
service and volume counts, and total size; it refreshes on its own and links
straight to **Activity** so you can watch the job and read its log (see
[Monitoring](./monitoring.md)). Because the CLI and the admin UI both write to
`infra/docker/backups/`, a snapshot made one way shows up in the other.

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

With `--stop-running`, the CLI stops the required tar targets and dependent API and restarts them after a successful restore. The database server stays running because replaying the
dump through `psql` needs it. For an OpenMapX database restore, the CLI also
stops `app-api` before the database is replaced and restarts it only after the
erasure journal has been replayed. If restore or replay fails, the API remains
stopped so it cannot expose resurrected account data.

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

The Maintenance update dialog offers a database backup by default and permits
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
