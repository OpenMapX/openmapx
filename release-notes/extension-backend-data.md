---
impacts: [breaking, migration, operator-action]
---

## What changes

Installed extensions can keep data, run scheduled work and take part in erasure
and export, and the API can now start without them when one of them stops it.

**Database access.** An integration that requires PostGIS or declares
`database.migrations: true` gets `ctx.db` with `transaction(fn, { timeoutMs })`
besides `execute`. Transactions run on a separate API pool,
`openmapx-api-extensions`, of at most 2 connections, so each API process now opens
up to 16 database connections instead of 14, and one more while an integration's
migrations run at a start, reload or install. A transaction ends with
`ProviderTimeoutError` and rolls back when the wait for a connection, the
transaction, one of its statements or a pause between them outlasts its timeout
(default 30 seconds, at most 15 minutes), unless its callback has finished and the
COMMIT is already running. An integration runs one transaction at a time and
cannot nest them. For an integration that ships migrations, the search path is its
schema `ext_<id>` (hyphens as underscores), then `extensions`, where PostGIS lives;
`public` is not on it, so platform tables are named with their schema. Its `ctx.db`
refuses to run while that schema is missing and once the integration's data was
removed. When a reload retires an installed integration or leaves it out, the API
waits at most 10 seconds for each of its shutdown handlers; when the API stops, the
shutdown handlers of all installed integrations share 5 seconds in total. A stop
does not wait for extension database work: the database pools close after at most
2 seconds, and a statement or transaction still running is cut off; PostgreSQL
rolls back each transaction that had not reached its COMMIT. The API container's
stop grace period is now 20 seconds instead of Docker's default 10, which covers
the bounded steps of the stop sequence (at most 19 seconds, plus the time the
built-in integrations' shutdown handlers take).

**Extension schemas and migrations.** The API applies an integration's
`migrations/NNNN_name.sql` files at every start and reload, before it imports the
integration's code and outside its 60-second load budget, with the API's database
role, which can read and change every platform table. The files apply in order
into the schema `ext_<id>`, each once, all files of one start in one transaction,
and each is recorded with its SHA-256. A file may not change after it was applied,
a new file may not be numbered below an applied one, and a file may not contain
transaction control (`COMMIT`, `ROLLBACK`, `BEGIN`, `SAVEPOINT`), statements that
cannot run inside a transaction (such as `CREATE INDEX CONCURRENTLY` or `VACUUM`)
or `COPY ... FROM STDIN`. Each file runs with the search path set to the schema,
then `extensions`; the settings it changes end with it, and deferred constraints
are checked at its end. After each file the API refuses the migration unless every
foreign key from the schema to a table outside it, and every key to a table of the
schema that such a cascade deletes rows from, is `ON DELETE CASCADE`; `SET NULL`,
`SET DEFAULT`, `NO ACTION` and `RESTRICT` are refused there, and keys on or to a
partitioned table are judged for each partition. An extension that needs to keep
rows stores the account id without a foreign key and erases the rows through its
subject-data handler. While the schema's keys change only through the extension's
own migration files, no foreign key of the schema can make deleting an account
fail. The check does not judge triggers, rules or check constraints, objects a
file creates outside its schema (they are not removed with the extension's data
either), a key another integration's migration adds to this schema, or a key
created through `ctx.db`. When such a key refuses an account deletion, through
the person's own deletion or an administrator's removal, the deletion fails with
`409 EXTENSION_BLOCKS_ACCOUNT_DELETION` and the account stays unchanged (the
erasure journal no longer records a request for a deletion the database refused,
so restoring a backup does not erase the account), the API logs the key, its
table and schema, and the attention list shows "<extension>
blocks account deletion"; the item resolves itself at the next daily check once
the key is dropped or changed to `ON DELETE CASCADE`.

Migrations wait at most 2 minutes for a lock and run at most 30 minutes in all;
both limits are also set on the database session, so PostgreSQL ends a migration
whose API process went away. A stop request cancels running migrations. While
migrations run at start-up the API does not serve requests yet, and a long
migration can make the container unhealthy; a restart starts it over. When a file
fails or a limit is reached, everything is rolled back and the extension is left
out with the step **migrate**. An extension rolled back to a version with fewer
migrations than were applied still loads, and the attention list warns that it
"runs against a newer database schema". Removing an extension's data drops its
schema and its bookkeeping rows.

**Scheduled tasks.** `ctx.schedule(name, { cron | everyMs, deadlineMs }, handler)`
runs work on a five-field cron expression in UTC (or a nickname such as `@daily`)
or every `everyMs` (at least one minute). A task runs at most once at a time; a
tick while it still runs is skipped. At `deadlineMs` (1 second to 6 hours) its
signal aborts and the run is recorded as failed with "deadline exceeded". Every
run appears in **Admin → Activity** as `<integration id>:<task name>` with the
status `running`, `succeeded` or `failed`; runs cannot be cancelled there, finished
runs are deleted 30 days after they started, and runs a previous process left
running are marked failed with "interrupted by restart" at the next start. That
recovery assumes one API process per instance.

**Erasure and export.** An extension registers
`ctx.registerSubjectDataHandler({ erase, export })` once in `setup()`. Deleting an
account records one pending erasure for every extension with a handler, also one
that is disabled, failed or not running, and never waits for an extension. The API
works the pending erasures off after the deletion, after every reload and daily;
`erase(subjectId)` must remove everything about the account, be idempotent and
finish within 30 seconds, and it is retried until it succeeds. Erasures that fail
or cannot run show as "Erasure pending in <extension>" on the attention list. A
person's data download includes `extensions/<id>.json` from every running
extension; `export(subjectId)` must return JSON-serialisable data of at most
8 MiB within 30 seconds. An extension that may hold the person's data and could
not be asked (not running, no longer installed while its data is kept, no export
handler, failing, too slow or too large) is
named in the download's README under "Extensions that could not be asked" and gets
an operator task on the privacy case, which the case view shows with the
extension's name and the reason. When such an export finishes after the case was
completed, by an administrator or by the person withdrawing it, the case returns to `in_progress` with the
events `status_changed` (reason `export-incomplete`) and `export_incomplete`, and
its retention holds come back until it is closed again. Extensions may describe
their data for the privacy report in `subjectData.registrations`. The privacy
catalogue gains the retention kind `until-erased`, reserved for the platform's own
record of pending erasures. The account deletion page and the user documentation
now say that data in OpenMapX itself is deleted immediately and that installed
extensions erase theirs, usually at once and otherwise once they run again.

**Safe mode and recovery.** Safe mode starts the API without any installed
extension; built-in integrations, the administration and all containers run as
usual, and installed integrations stay listed with the chip **Safe mode**. It is
turned on with `openmapx control safe-mode on` (which works while the API is down),
forced with `OPENMAPX_SAFE_MODE=1`, or turned on automatically; it is left from
**Admin → Integrations → Leave safe mode** or with `openmapx control safe-mode off`.
The state lives in a new bind mount, `infra/docker/data/api-runtime` (in the
container `/var/lib/openmapx/runtime`). Loader gates hold back the integrations of
a disabled extension (**Extension disabled**) and of an extension this release
cannot run (**Not compatible**), and load none when the extension state cannot be
read. `openmapx extensions disable <id> --offline` marks an extension disabled in
the running database without the API, for its next start; `openmapx ext` stays an alias of
`openmapx extensions`. An install or update job now fails when the reload did not
load the integration it installed, unless the operator held it back.

The API turns safe mode on by itself after it stopped without being asked three
times within ten minutes once installed extension code had started loading; a
requested stop never counts. The attention item **Safe mode after repeated
crashes** names the extension when the crashes name one. A watchdog thread ends
the API with SIGKILL when its event loop stays blocked for 30 seconds
(`OPENMAPX_EVENT_LOOP_WATCHDOG_MS`; at least 5000, `0` turns it off), and for
60 seconds, or the configured value when larger, from the first installed
extension's load until the API listens; such a kill counts like a crash. The API
image now starts Node under `tini`, so that kill takes effect.

A disabled extension cannot be enabled again in this release: an update keeps it
disabled, and removing it and installing it again starts it enabled and keeps its
data.

**Admin API.** Integration `status` gains `safe-mode` and `incompatible`, and
`loadErrorPhase` gains `platform` (the API could not try the integration's code,
for example because the extension state could not be read). New routes:
`GET /api/admin/safe-mode` and `POST /api/admin/safe-mode/leave`. Activity jobs gain
the source `integration-task`, whose cancel answers 409. Privacy case tasks gain
an optional `integrationName`, case events the type `export_incomplete`, and the
audit log the action `safe_mode.leave`. Clients that parse these values strictly
reject the new ones.

## Who is affected

Operators of instances with installed extensions, and anyone sizing PostgreSQL's
`max_connections`; clients of the admin integration, Activity, privacy and audit
APIs; extension authors who want to store data, schedule work or hold personal
data.

## Required action

Make sure PostgreSQL's `max_connections` covers 17 connections per API process
(16 pooled, one for migrations) plus the data manager and other clients. Run one API process per instance. Keep
`infra/docker/data/api-runtime` with the deployment; `openmapx compose` creates it
when it renders the stack. Update admin API clients for the new status values, fields, Activity
source, case event type and audit action. Extension authors whose extension keeps
personal data must register a subject-data handler, and must use
`ON DELETE CASCADE` for keys that a deletion outside their schema can reach.

The database baseline changes in place: its checks gain the case event type
`export_incomplete` and the audit action `safe_mode.leave`. There is no migration,
and no released version precedes this change, so new installations need no
action; a development database created from an earlier baseline must be
recreated.
