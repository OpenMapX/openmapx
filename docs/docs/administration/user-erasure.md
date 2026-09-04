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
