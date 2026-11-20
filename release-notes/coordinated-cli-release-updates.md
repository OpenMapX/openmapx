---
impacts: [operator-action]
---

## What changes

The host CLI can check immutable release metadata without changing running pins
and drive the coordinated public administrator update with a mandatory backup
and a resumable receipt.

## Who is affected

Self-hosted operators updating OpenMapX from the command line.

## Required action

Use System → Updates or `compose release --check` followed by authenticated
`system update` from a current checkout. The CLI requires an operator-provided
private full-administrator session file and a private receipt; it never discovers
browser credentials. Resume the same receipt after connection loss and inspect
Activity before starting a different operation. Image selection does not reverse
database migrations. See the upgrading guide for the full procedure.
