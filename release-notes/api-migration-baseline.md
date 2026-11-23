---
impacts: [breaking, migration]
---

## What changes

The API's database migration history is replaced by a single baseline: one
migration that drizzle-kit generates from the schema code, and one that adds the
roles' grants, the account role check, the last-administrator guard and the
account erasure trigger. The
resulting schema is the same as before, apart from the order of some columns and
the changes below.

The database refuses a second account for the same sign-in provider identity and
a second passkey with the same credential ID. Session and OAuth token expiry are
indexed for pruning.

Every timestamp in OpenMapX's own tables now stores its time zone. The API,
data-manager and CLI run every database session in UTC, so timestamps, retention
cutoffs and legal holds stay correct when the database's default time zone is
not UTC, for example after `ALTER DATABASE … SET timezone` or on a managed
PostgreSQL.

OpenMapX's own tables use one kind of id. Records such as saved lists and
places, vehicles, parking records, share links, admin jobs and audit entries
have native UUID ids that the database assigns with `uuidv7()`; log and health
history rows have identity columns instead of serial sequences. The API refuses
an id in a request path or body that is not a UUID with status 400 instead of
looking it up. A version 7 UUID contains the time it was created.

Deleting an account erases its traces in the database however it is deleted:
in the app, by the restore replay or with plain SQL. Every column that holds
an account's id either has a foreign key that clears it or is cleared by a
trigger on the account table. Newly covered are the updater of a system
setting, the actor of a privacy case event, the data jobs the account started,
pending administrator confirmations of actions on the account, and the
sessions an administrator was impersonating, which are deleted with that
administrator. The restore replay now deletes erased accounts and leaves the
rest to that trigger. Audit details and log entries are cleared when they
mention the account's id or its email address as a whole address, ignoring
case; a longer address that merely contains it, such as
`alice.bob@example.com` for `bob@example.com`, is no longer affected. Offline-package records of an account erased by a
restore remain until their 30-day retention ends; a deletion in the app removes
them at once.

The database checks the fixed value sets of OpenMapX's own tables, such as job
and health statuses, share-link targets and modes, extension trust and source
kinds, vehicle kinds and powertrains, parking sources, timeline connection
states, account actions, and data-manager's transit run stages and offline
package states. It refuses a share link whose shape the app never
writes (a route share that is live or names a target, a list share without its
list, a snapshot without its payload or a live share with one) and a second
passphrase unlock for the same review key.
Every foreign key column is indexed, as are the paths retention prunes by age;
indexes that duplicate a unique constraint or that no query uses are gone.

Integration and service configuration and their encrypted secrets are keyed by
what they configure (the integration or service id, plus the secret's key)
instead of a separate random id. Each line of an administrative job's log is
keyed by its job and its position in that log, which the database assigns, so
the lines of several operations in one job never collide; a line relayed from
the operations agent is still written once when the agent repeats it. The
job's log line and byte counts are plain columns instead of values rewritten in
the job's runner state on every line. In the admin Activity API a job's log
lines no longer carry an `id`; `seq` identifies a line within its job.

Which extension owns an installed integration is recorded once, as the
extension's component link; the integration and service repository records no
longer carry their own copy. An extension's removal finds its service
repositories from its recorded manifest and the operations agent, which already
records each repository's owner. The stored auth policy no longer has a constant
activation version column: a stored policy is the activation. The admin API's
policy responses still report `activationVersion`.

Local integration directories without an owner record can no longer be adopted:
the admin endpoint `POST /api/admin/standalone-integrations/:id/adopt`, the
Activity job type `standalone.adopt` and the `legacy_unknown` provenance kind
are gone. Such a directory can still be removed, or installed again through
**Install integration** so that its source is recorded. In the local
integration inventory, `provenance` is `null` instead of `legacy_unknown` when
no standalone install recorded a source, and entries no longer carry
`adoptable`. Assisted privacy requests no longer accept the `username` subject
locator type; OpenMapX accounts have no usernames.

Secret system settings, such as the SMTP password, live encrypted in a new
`system_secret` table instead of in clear in `system_settings`; its updater is
cleared when that account is deleted. See the separate note on the generated
secrets key.

Data-manager keeps one state row per transit feed, keyed by its region and
source name, so two runs at once no longer create a duplicate row or lose a
validation failure from the count. In the admin API's transit feed list, entries
no longer carry an `id`; the region and name identify a feed. The Overture
release each region imported is recorded in its own
`data_manager.overture_release` table instead of a transit feed row.

`data_manager.jobs` holds only durable executions, the only kind of job
data-manager writes. Every execution column is required, the operation key is
a plain unique key, and the status is one of the eight execution statuses. The
admission time, deadline and requested deadline are `timestamptz` instead of
epoch milliseconds; the duplicate `started_at` and the constant
`execution_version` are gone, and the execution reference moved from
`metadata` to its own `execution_ref` column. In the admin API, a transit job's
`startedAt` is its admission time, and a data-manager job's Activity payload is
always its execution input.

A finished data-manager job, with the account that started it, is deleted 90
days after it finished, as the privacy catalogue now states (it stated ten
years). `ADMIN_JOB_RETENTION_DAYS` no longer applies to data-manager jobs, and
the newest run of each kind is no longer kept past that period. Data-manager's
control prune removes only a job's execution row and the files named by its
key; the job row stays until then. A finished job that data-manager has not
swept by then, for example because it is stopped, stays without the account.

The constraints and indexes of OpenMapX's own tables follow PostgreSQL's naming
convention: `<table>_pkey`, `<table>_<columns>_key`, `<table>_<columns>_idx`,
`<table>_<column>_fkey` and `<table>_<what>_check`. A partial unique index
names the rows it covers, such as `mangrove_keypair_wrap_user_id_passphrase_key`.
No name exceeds PostgreSQL's 63-character limit, so none is truncated. The
account role check on the `user` table is `user_role_check`; otherwise the
tables of Better Auth keep the names it generates.

## Who is affected

Every database created by an earlier development build, including local
development databases. No released installation exists.

## Required action

Install fresh with an empty database volume. The API refuses to start on a
database created before this change and reports
`schema "data_manager" already exists`; there is no upgrade path. Recreate
local development databases and apply the migrations again.

Later schema changes are made the usual way: once a release containing this
baseline is installed anywhere, each change adds an incremental migration and
the baseline is never regenerated again.
