---
impacts: [operator-action]
---

## What changes

System inspection now accepts its selected-release field instead of reporting
maintenance unavailable. The host CLI can check immutable release metadata
without changing running pins and drive the coordinated public administrator
update with a mandatory backup and a resumable receipt.

Bare release selection refuses to replace a running Data Manager's image pin.
Clearing refuses a valid overlay that its matching coordinator still uses.
These guards preserve the ownership evidence needed by the coordinated updater.

## Who is affected

Self-hosted operators updating an existing OpenMapX installation, especially
installations where the older maintenance status contract disables panel updates.

## Required action

Use System → Updates or `compose release --check` followed by authenticated
`system update` from a current checkout. The CLI requires an operator-provided
private full-administrator session file and a private receipt; it never discovers
browser credentials. Resume the same receipt after connection loss and inspect
Activity before starting a different operation. Bare `compose release` remains
available for clean bootstrap or restoring the exact pin already used by Data
Manager. Do not delete pending journals or writer guards. Image selection does
not reverse database migrations. See the upgrading guide for the full procedure.
