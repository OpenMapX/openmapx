---
title: User erasure operations
description: Verify account deletion, backup expiry and restore replay, and handle external Mangrove and Dawarich data.
sidebar_position: 8
---

# User erasure operations

Use this runbook after an authorized account deletion. For a self-service
request, the person deletes their account in settings after a recent sign-in; for an administrator-led
request, verify identity and scope before using **Users → Delete**. Keep a
separate record of processor and off-host work that OpenMapX cannot perform.

OpenMapX account deletion removes live account-owned rows through database
cascades and clears every other column that names the account through a
foreign key or the database's erasure trigger, which runs on every deletion of
an account row: from the app, from the restore replay or from plain SQL. The
trigger deletes pending verification challenges: rows whose value is the
account ID, rows for the account's email, the emailed sign-in, email
verification, password reset and email change codes for that address, and
the codes sent to a new address the account asked to change to. Another
account's challenges stay, including those for a longer address that contains
this one. It also deletes persisted log entries that mention
the account's ID or its email as a whole address (in any letter case, but not
a longer address that contains it), pending administrator confirmations of account
actions and the sessions the account impersonated as an administrator. It
clears the account from data jobs it started. Audit events and privacy case
events may remain for accountability, but the deleted actor's ID, IP address,
user agent, target ID and matching details are cleared. The API also removes the
account's offline-package records, which name it only by a keyed hash. Before
that transaction starts, the API durably appends an HMAC-pseudonymised request
to the erasure journal. If the journal is unavailable, deletion fails without
pretending that it succeeded.

Extensions that keep data about people register a handler that erases it.
The trigger records the deleted account once for each such extension, also
while the extension is disabled, failed or otherwise not running. The API
then asks each running extension to erase the account's data: right after the
deletion, after every reload of the integrations and once a day. The
deletion itself never waits for an extension. A record stays until the
extension reports success, so an extension that is not running, fails or
does not answer within 30 seconds is asked again later. While an extension
fails, the administration's attention list shows "Erasure pending in
_extension_" with its last error; the item disappears once nothing is pending
for that extension. The record holds only the deleted account's ID and the
extension. It is also removed when the extension stops handling personal data
or its data is removed.

Delete accounts in the app. Deleting with plain SQL as `openmapx_api`
(`DELETE FROM "user" WHERE id = …`) runs the same trigger but not the API's
journal entry or offline-package cleanup. `TRUNCATE "user"` fires no row
trigger and leaves all of this behind.

After the server confirms self-service deletion, the browser attempts to clear
React Query state, OpenMapX IndexedDB data, offline packages, Cache Storage and
local/session storage. Browser restrictions or storage errors can prevent parts
of that cleanup; manually clear the app or site data when verification is needed.
The operator cannot remotely erase storage on other devices, which also need
local cleanup.

## Access and portability requests

The account settings **Your data and access request** section downloads an
Article 15 copy together with the Article 20 portable data. The response
deadline is recorded when the request is received. A fresh sign-in (including
configured MFA) is required for each download. The archive streams straight to
the browser and is never stored on the server, and no download link is sent by
email.

The archive covers explicit OpenMapX projections and connected managed Dawarich
data when that processor responds. Other controllers, off-host backups,
operator logs and unavailable sources appear as reviewed omissions or tasks.
The **Download browser data** action is a separate local JSON supplement: it
contains only an allowlisted preference snapshot and offline-map metadata, not
cookies, sessions, credentials, caches or raw map archives.

Account deletion keeps the privacy case records, which are needed to account
for the response, and marks every request of the deleted account as such.
Nothing else about the case survives: there is no stored archive or evidence
file to delete. A restore replays the same change for an account deleted after
the snapshot.

A request for data held in backups is answered manually with the
[manual backup export](./backup-and-restore.md#manual-backup-export-for-a-privacy-request).

## Backups

Keep `RETENTION_BACKUP_DAYS` aligned with the period disclosed in your privacy
notice (default 30). The operations agent prunes at startup and daily, every
successful backup also prunes, and restore refuses expired archives. Restore
also verifies the journal/key binding, refuses a backup older than journal
coverage, and replays every retained erasure request after loading the OpenMapX
database: it deletes each matching account row as `openmapx_api`, which runs
the erasure trigger with the API role's rights. The replay cannot derive the
offline-package key hash, so restored offline-package records of an erased
account remain until their 30-day retention ends: the API's daily retention
deletes offline-package records that match no existing account 30 days after
they were recorded. That includes every record under an earlier offline-package
principal key once the key is rotated. The package files stay on disk until the
Data Manager evicts or invalidates them; they are area extracts that name no
account. Journal compaction advances the coverage floor when old requests
are discarded; increasing backup retention later cannot make those older
backups safe to restore again. When `api`
is running, restore requires `--stop-running`; it keeps the API offline until
that replay succeeds and leaves it stopped if replay fails.

Copy these three items together for disaster recovery and protect them at least
as strongly as the database:

- `infra/docker/backups/`
- `infra/docker/data/erasure/journal.jsonl`
- `infra/docker/secrets/erasure-journal-key`

Off-host storage needs its own lifecycle rule. OpenMapX cannot prune a copy it
does not control.

The journal must be a regular, single-link `0600` file in its protected `0700`
directory. The key must be a regular, single-link `0444` file owned by the
configured `ERASURE_JOURNAL_KEY_UID`; generated Compose supplies that UID.
For local development, set it to the actual key-file owner. Reads reject
symlinks, oversized files and metadata changes during the read.

Journal writes and compaction use `journal.jsonl.lock` to prevent a deletion
request from being lost during atomic compaction. If a process is forcibly
killed, it can leave that empty lock directory behind. First confirm no API,
restore, or compaction operation is active; only then remove the stale directory
and retry. Account deletion and restore fail closed while the lock exists.

## External systems

Mangrove reviews are public, signed records outside the OpenMapX database. A
user should delete reviews through the review controls before deleting the
OpenMapX signing key. Account deletion cannot retract them afterwards.

A connected or managed Dawarich account and its location history are a separate
data store. Disconnecting or deleting OpenMapX removes only the encrypted
connection. For the currently pinned managed Dawarich release, an authorised
operator must use the Dawarich Rails console in the `dawarich-app` container,
locate the exact account, review the match, and call `destroy!`; follow the
Dawarich release documentation and take care not to target another user. Record
completion in the controller's request ticket without copying location history.

For any other configured processor or external integration, forward the erasure
request where the operator is the controller, document the response, and tell
the user which independently controlled public data cannot be removed by
OpenMapX.

## Verification checklist

1. Confirm the account can no longer authenticate and no `user` row remains.
2. Confirm account-owned API resources return no records.
3. Confirm journal append/completion succeeded without exposing its protected
   contents. An incomplete pair requires investigation; do not insert completion
   records by hand. Journal identifiers are HMAC-pseudonyms, not raw user IDs or
   emails.
4. Run `pnpm openmapx backup prune --retention-days <configured-days>` and verify
   off-host lifecycle rules.
5. Complete any Dawarich/processor action and communicate the external Mangrove
   boundary.
6. Confirm the attention list shows no "Erasure pending in …" item. If one
   stays, fix or re-enable the extension it names; the API asks it again.

For a recovery drill, restore a retained backup in a disposable deployment and
verify that replay removes the erased account before the API resumes. This is a
runtime check; inspecting the journal or reading a saved test receipt does not
establish restore safety for the current deployment. See
[Backup and restore](./backup-and-restore.md#restoring).
