---
title: User erasure operations
description: Verify account deletion, backup expiry and restore replay, and handle external Mangrove and Dawarich data.
sidebar_position: 8
---

# User erasure operations

Use this runbook after an authorized account deletion. For a self-service
request, the person deletes their account in settings; for an administrator-led
request, verify identity and scope before using **Users → Delete**. Keep a
separate record of processor and off-host work that OpenMapX cannot perform.

OpenMapX account deletion removes live account-owned rows through database
cascades and explicitly scrubs verification challenges, system-setting updater
IDs, exactly matched persisted log references, and identifiers in audit records. Audit events may
remain for accountability, but the deleted actor's ID, IP address, user agent,
target ID, and matching details are cleared. Before that transaction starts, the API
durably appends an HMAC-pseudonymised request to the erasure journal. If the
journal is unavailable, deletion fails without pretending that it succeeded.

After the server confirms self-service deletion, the browser attempts to clear
React Query state, OpenMapX IndexedDB data, offline packages, Cache Storage and
local/session storage. Browser restrictions or storage errors can prevent parts
of that cleanup; manually clear the app or site data when verification is needed.
The operator cannot remotely erase storage on other devices, which also need
local cleanup.

## Access and portability requests

The account settings **Your data and access request** section starts an
Article 15 request and, by default, asks for a separate Article 20 portable
copy. The response deadline is recorded when the request is received. A fresh
sign-in (including configured MFA) is required for each archive download; the
one-time authorization is consumed before streaming and the encrypted archive
expires automatically. A download link is never sent by email.

The archive covers explicit OpenMapX projections and connected managed Dawarich
data when that processor responds. Other controllers, off-host backups,
operator logs and unavailable sources appear as reviewed omissions or tasks.
The **Download browser data** action is a separate local JSON supplement: it
contains only an allowlisted preference snapshot and offline-map metadata, not
cookies, sessions, credentials, caches or raw map archives.

An active access case can retain its already captured, minimized encrypted
source material and prepared response after account deletion for verified
assisted delivery. This does not retain usable account credentials or restore
login access. Terminal case outcomes and source/artifact expiry trigger
separate physical cleanup; key metadata is cleared only after deletion is
confirmed. Case accounting retention does not extend full source-data retention.
After a receipt snapshot expires, regeneration requires explicit review of the
missing source rather than silently collecting a later state.

Restore applies the same distinction between active and terminal cases. It
revokes restored terminal export artifacts and expires their attachments and
source snapshots before the API resumes. Physical cleanup then uses the
normal monitored retry path; restored keys and deletion records are retained
until that cleanup confirms removal. A restore must not mark still-present
ciphertext as deleted. The private export volume is excluded from backups and
cannot be restored from an archive through this workflow.

## Backups

Keep `BACKUP_RETENTION_DAYS` aligned with the period disclosed in your privacy
notice (default 30). The operations agent prunes at startup and daily, every
successful backup also prunes, and restore refuses expired archives. Restore
also verifies the journal/key binding, refuses a backup older than journal
coverage, and replays every retained erasure request after loading the OpenMapX
database. Journal compaction advances the coverage floor when old requests
are discarded; increasing backup retention later cannot make those older
backups safe to restore again. When `app-api`
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

For a recovery drill, restore a retained backup in a disposable deployment and
verify that replay removes the erased account before the API resumes. This is a
runtime check; inspecting the journal or reading a saved test receipt does not
establish restore safety for the current deployment. See
[Backup and restore](./backup-and-restore.md#restoring).
