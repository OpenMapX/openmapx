---
title: Backup & restore
description: Snapshot the irreplaceable state of an OpenMapX deployment — the database, ACME certificates, and cache — with the backup CLI and admin UI, and restore from it.
sidebar_position: 7
---

# Backup & restore

Most of what an OpenMapX deployment stores is rebuildable. The routing graphs,
geocoding indexes, and rendered tiles are all derived from the OSM extracts and
GTFS feeds the data-manager already tracks, so losing them costs build time, not
information. What you cannot regenerate is the *state* that accumulated while the
instance ran: the user accounts, admin settings, integration configuration, and
ingested POI data in the database, plus the TLS certificates and secrets that
keep the front door open.

OpenMapX backs up exactly that irreplaceable state — and deliberately skips the
rebuildable bulk — through the `openmapx backup` CLI and the **Backups** page in
the admin panel. This page explains what gets captured, what doesn't, what you
still have to copy aside yourself, and how to restore.

## What gets backed up

Every service declares its volumes in its manifest, and each volume carries a
`backup` flag. The backup tooling walks the enabled services and snapshots only
the volumes flagged `backup: true`. Three of them are:

- **`postgis`** — the PostgreSQL/PostGIS database. This is the important one: user
  accounts and sessions, saved places, vehicle and parking state, share payloads,
  Timeline connection metadata, the audit log, all admin and integration
  configuration, and ingested data-source rows (EV charging, parking, and the
  rest) live here. It is captured with a streamed `pg_dump` piped through gzip
  while the database stays running.
- **`redis`** — the Valkey (Redis-compatible) cache. Holds the transit registry
  snapshot and assorted app caches. Captured as a gzipped `tar` of the volume.
- **`traefik`** — the reverse proxy's ACME state, i.e. the Let's Encrypt
  certificates Traefik obtained for your domain. Captured as a gzipped `tar`.

For the database, the dump streams to disk through a Node pipeline rather than
buffering in memory, so a production-sized database snapshots without exhausting
the process heap. For the `tar`-mode volumes, the producing service is stopped
for the duration of the copy and restarted afterward, so the archive is
consistent.

Each snapshot lands in its own directory under `infra/docker/backups/<name>/`,
next to a `manifest.json` that records the platform version it was taken on, the
producing service for each volume, and the resolved on-host Docker volume name.
That last detail means a backup stays restorable even if the Compose project name
changes between backup and restore — a different working directory, an overridden
project name, or a host migration.

## What gets skipped, and why

The heavy, region-derived index volumes are intentionally **excluded** — their
manifests set `backup: false`, or they're bind-mounted data trees the tooling
never touches:

- Nominatim's geocoding database
- Elasticsearch (the Pelias backend)
- the Valhalla, MOTIS, Photon, TileServer, and Overpass data directories

These rebuild from the OSM PBF and GTFS feeds the data-manager manages. On a
country-sized deployment they can run to tens or hundreds of gigabytes, so
snapshotting them would dominate every backup for no recovery benefit — and after
a disaster you usually want a *fresh* index from current source data anyway, not a
stale one from an old archive. To rebuild these after a restore, follow
[Preparing data](../install/preparing-data.md).

:::caution[The `.env` file is not in the backup]
The backup captures volumes, not your configuration file. `infra/docker/.env`
holds the secrets the whole stack depends on — `POSTGRES_PASSWORD`,
`BETTER_AUTH_SECRET`, `OPENMAPX_SECRETS_KEY`, integration API keys, and the rest —
and it is **never** part of a snapshot, nor does it travel with a `git pull`. A
database restored without the matching `POSTGRES_PASSWORD` won't come up, and
vault-encrypted integration secrets in the database can't be decrypted without
the same `OPENMAPX_SECRETS_KEY` that encrypted them. Copy the file
aside yourself and store it somewhere safe:

```bash
cp infra/docker/.env infra/docker/.env.bak
```
:::

For real disaster recovery, also remember that `infra/docker/backups/` lives on
the same host as the deployment. Copy the snapshot directory (and your `.env`)
off the machine — to object storage or another host — so a lost disk doesn't take
the backups with it. The tooling produces the archive; getting a second copy
somewhere else is up to you. See [Configuration](../install/configuration.md) for
the full `.env` reference.

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
copies—the local scheduler cannot delete objects in storage it does not control. The
[user-data trust model](../developer/user-data-trust-model.md) describes the
boundaries in detail.
:::

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
service and volume counts, and size. A directory whose `manifest.json` is missing
or malformed — the typical sign of a snapshot that failed partway through — is
flagged as **corrupt** in both the list and the admin table. A corrupt entry
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
must be readable; the backup must not predate the journal's coverage marker; and
the platform version in the snapshot's manifest must be compatible. A **major-version**
mismatch is refused outright, while a minor mismatch prints a warning and
proceeds. If a targeted volume service is running, or if `app-api` is serving
the OpenMapX database being restored, the restore refuses unless you opt in:

```bash
pnpm openmapx backup restore weekly --stop-running
```

With `--stop-running`, the CLI stops each running volume target and brings it
back after restoration. The database server stays running because replaying the
dump through `psql` needs it. For an OpenMapX database restore, the CLI also
stops `app-api` before the database is replaced and restarts it only after the
erasure journal has been replayed. If restore or replay fails, the API remains
stopped so it cannot expose resurrected account data.

Immediately after the database dump is loaded, the CLI HMAC-matches restored
user IDs against `infra/docker/data/erasure/journal.jsonl` and removes every
match. The journal contains neither raw user IDs nor email addresses. The journal
and `infra/docker/secrets/erasure-journal-key` are deliberately outside the
PostgreSQL backup. Disaster-recovery copies must include both. Do not rotate or
discard the key while a backup that could contain an erased account exists;
without it, OpenMapX refuses the restore rather than risk resurrecting data.

To restore only part of a snapshot, name the services:

```bash
pnpm openmapx backup restore weekly --services postgis --stop-running
```

The admin UI mirrors all of this. Click the restore action on a row, optionally
type a comma-separated list of service IDs to limit the scope, toggle **stop
running target services** if needed, and confirm — the restore runs as a
background job you can follow in **Activity**. A separate delete action removes a
snapshot directory entirely and cannot be undone.

:::note[After restoring the database]
The `app-api` container applies pending Drizzle migrations on every boot, so as
long as you restore a snapshot from a compatible version, the schema is brought
up to date automatically the next time the API starts. This is also why crossing
a major version is refused: an older dump may predate schema changes the running
code requires.
:::

## Back up before you upgrade

The first step of any upgrade is a backup — it's the one thing that makes a bad
upgrade reversible, because Drizzle migrations are forward-only and an upgraded
`app-api` will have migrated the database on boot. Take a named snapshot, copy
your `.env` aside, and only then pull new code and images:

```bash
pnpm openmapx backup create --name pre-upgrade
cp infra/docker/.env infra/docker/.env.bak
```

If the upgrade goes wrong, restore `pre-upgrade`. The full sequence is in
[Upgrading](../install/upgrading.md).

## A reasonable routine

A practical baseline for a self-hosted instance:

- Take a snapshot before every upgrade, named for what you're about to do.
- Take a regular snapshot — daily or weekly, depending on how much data your
  instance ingests — and copy both the snapshot directory and `infra/docker/.env`
  off the host.
- Verify the automatic policy with `backup prune --retention-days 30`; use
  `backup delete <name>` for an exceptional early removal.
- Keep the rebuildable indexes out of mind for backup purposes; plan to rebuild
  them from source data after a recovery, as covered in
  [Preparing data](../install/preparing-data.md).

## Where to go next

- **[Upgrading](../install/upgrading.md)** — the upgrade flow that opens with a
  backup.
- **[Configuration](../install/configuration.md)** — the `infra/docker/.env`
  reference, the file you must back up by hand.
- **[Preparing data](../install/preparing-data.md)** — rebuilding the excluded
  index volumes from OSM and GTFS source data.
- **[Services administration](./services-administration.md)** — the admin
  Services section the Backups page lives under.
- **[Monitoring](./monitoring.md)** — the Activity view where backup and restore
  jobs report their progress.
