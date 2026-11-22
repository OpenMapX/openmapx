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

## Who is affected

Every database created by an earlier development build, including local
development databases. No released installation exists.

## Required action

Install fresh with an empty database volume. The API refuses to start on a
database created before this change and reports that a relation already exists;
there is no upgrade path. Recreate local development databases and apply the
migrations again.
