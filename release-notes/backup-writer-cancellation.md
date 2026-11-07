---
impacts: [operator-action]
---

## What changes

Backup cancellation supervises its PostgreSQL dump and terminates its separate
archive helper before deleting partial files. Incomplete dumps cannot publish a
backup based on a Docker client exit alone. Published backups survive restart
failure or cancellation during restart. Backup format and restore data are
unchanged.

## Who is affected

Operators creating backups, especially installations with community PostgreSQL
images or unusual checkout paths. The shipped PostGIS images already have Bash.

## Required action

Custom `pg_dump` images must include Bash and `pg_dump` in PATH. The Docker engine
must provide `docker-init`. Volume backups refuse installation paths containing
commas, quotes or newlines. No existing backup conversion is needed.

After interrupted cleanup, inspect service status and any incomplete backup's
reported `openmapx.backup-writer` label. Services may need restarting through the
normal workflow. A helper with uncertain removal keeps the partial directory;
confirm it is inactive or removed before deleting those files. Preserve source
volumes. See the backup and restore guide for cancellation limits.
