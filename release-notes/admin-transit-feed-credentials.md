---
impacts: [breaking, migration, operator-action]
---

## What changes

The Transit administration page manages a masked map of per-feed credentials
against the active Transitous and atlas pins. Changes require a reviewed preview
and fresh administrator sign-in. Unselected and obsolete keys are preserved;
deleting a key requires an explicit selection. The same guarded operation saves
the encrypted map and recreates an already running Data Manager to consume it.

Migration `0048_admin_transit_credentials` adds encrypted, temporary credential
proposals. Completed operations retain recovery inputs for at least 72 hours;
unresolved operations retain their inputs until they can be reconciled. Values
are excluded from public previews, job metadata and account data exports.

The remote `generate-api-keys` operation is retired. The local
`openmapx data generate-api-keys` command remains available, reads the active pins
and preserves existing values and orphaned keys without updating the shared
catalog checkout.

## Who is affected

Operators managing Transitous feed credentials, including installations using
`TRANSITOUS_API_KEYS_PATH`, a custom `TRANSITOUS_API_KEYS_FILE`, or an existing
`/config/transitous/api-keys.json` file.

## Required action

Apply the normal API migrations when upgrading and upgrade the API, CLI and
ops-agent together. Use **Administration → Transit → Transit feed credentials**
for vault-managed credentials. Data Manager must already be running; this action
does not start a stopped coordinator. Inspect Activity before retrying an
unresolved operation.

Existing files and environment overrides remain host-owned and read-only in the
panel. Continue managing them on the host unless deliberately changing their
ownership. No file is imported, replaced or deleted automatically. Integrations
that called the retired remote generator must use the credential workflow or
explicit host-local CLI management instead.

Account deletion also waits for the administrator's unfinished instance
operations. Finish or cancel those operations in Activity first, so their
private recovery inputs remain available until settlement.
