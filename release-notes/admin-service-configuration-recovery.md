---
impacts: [breaking, operator-action]
---

## What changes

Service administration requests now enforce explicit, strict JSON shapes. Extra
top-level fields and malformed values are rejected before the requested effect:

- `PUT /api/admin/services/selection` requires `{ "selectedRoots": ["service-id"] }`.
  The array must contain nonblank strings. An explicit `[]` remains a valid,
  deliberate empty selection; an omitted field, `null`, a scalar, or invalid
  array members are rejected.
- `POST /api/admin/services/{id}/action` accepts only an `action` of `start`,
  `stop`, or `restart`. `POST /api/admin/services/bulk-action` accepts `action`,
  `serviceIds`, and optional
  boolean `continueOnError`: `start`, `stop`, `restart`, and `update` require a
  nonempty array of nonblank service IDs. The `build` alternative also accepts
  optional boolean `all` and string `region`, and requires a nonempty
  `serviceIds` array or `all: true`.
- Credential writes (`PUT /api/admin/services/{id}/credentials/{key}`) accept
  only `{ "value": "nonblank secret" }`. The value must be a nonblank string;
  its bytes are preserved. Config writes (`POST /api/admin/services/{id}/config`)
  require `{ "config": { ... } }`, with a JSON object under `config`. Unknown,
  read-only, secret, or invalid config fields remain subject to the service's
  manifest validation; strict envelope validation does not replace it.
- Backup restore (`POST /api/admin/services/backups/{name}/restore`) accepts an
  optional object containing only optional `serviceIds` (an array of nonblank
  strings) and `stopRunning` (a boolean). Omitting the body, omitting `serviceIds`,
  or supplying `serviceIds: []` still selects all services in the backup.
  `stopRunning` defaults to false. `null`, scalars, invalid array members,
  nonboolean `stopRunning`, and extra fields are rejected. Bodies have not become
  universally mandatory.

Failed service configuration activation can restore saved overrides only while
that request still owns the exact database row version. Later edits are retained.
A failed or uncertain activation remains an error and does not promise restoration
or successful host activation.

Data operations now queue validated raw form input and normalize it again at
execution. Full Update Pipeline requests with country filters can reach the typed
update operation; previews and audit details remain normalized.

## Who is affected

Administrators changing service configuration or running data operations,
especially Full Update Pipeline jobs with a nonempty countries filter.
Administrative scripts and external API callers that send omitted selection
intent, extra fields, or malformed action, credential, config, or restore values
must also update their requests.

## Required action

Before upgrading, update affected administrative callers to send the accepted
shapes above. Send an explicit `selectedRoots` array, including `[]` when an empty
selection is intended; keep restore-all intent distinct from that requirement.
Remove unsupported fields and use JSON booleans and arrays rather than string
substitutes. Rejected requests require corrected input, not an automatic retry.

After a failed configuration change, inspect the saved settings and applied host
state before deciding how to reconcile them. A newer saved edit may have prevented
restoration; an unknown host outcome is not evidence that activation failed.

Previously queued jobs containing normalized countries arrays remain invalid.
Inspect their outcome before explicitly submitting a new intended operation if
needed. This correction does not convert queued jobs, retry them automatically,
or require a database migration or cache reset.
