---
title: User erasure operations
description: Verify account deletion, backup expiry and restore replay, and handle external Mangrove and Dawarich data.
sidebar_position: 8
---

# User erasure operations

OpenMapX account deletion removes live account-owned rows through database
cascades and explicitly scrubs verification challenges, system-setting updater
IDs, matching persisted logs, and identifiers in audit records. Audit events may
remain for accountability, but the deleted actor's ID, IP address, user agent,
target ID, and matching details are cleared. Before that transaction starts, the API
durably appends an HMAC-pseudonymised request to the erasure journal. If the
journal is unavailable, deletion fails without pretending that it succeeded.

The browser that performs self-service deletion clears its React Query state,
OpenMapX IndexedDB data, downloaded offline packages, Cache Storage, and local
and session storage after the server confirms deletion. The operator cannot
remotely erase browser storage on other devices; tell the user to clear the app
or site data there.

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

## Backups

Keep `BACKUP_RETENTION_DAYS` aligned with the period disclosed in your privacy
notice (default 30). The operations agent prunes at startup and daily, every
successful backup also prunes, and restore refuses expired archives. Restore
also refuses a backup older than journal coverage and replays every retained
erasure request immediately after loading the OpenMapX database. When `app-api`
is running, restore requires `--stop-running`; it keeps the API offline until
that replay succeeds and leaves it stopped if replay fails.

Copy these three items together for disaster recovery and protect them at least
as strongly as the database:

- `infra/docker/backups/`
- `infra/docker/data/erasure/journal.jsonl`
- `infra/docker/secrets/erasure-journal-key`

Off-host storage needs its own lifecycle rule. OpenMapX cannot prune a copy it
does not control.

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
3. Confirm the erasure journal contains a request and completion pair (never a
   raw user ID or email).
4. Run `pnpm openmapx backup prune --retention-days <configured-days>` and verify
   off-host lifecycle rules.
5. Complete any Dawarich/processor action and communicate the external Mangrove
   boundary.
