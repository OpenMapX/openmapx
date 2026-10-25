---
impacts: [security]
---

## What changes

Encrypted Mangrove review-key envelopes now support at most 32 total
passphrase and passkey unlock methods. The API rejects larger create or replace
requests before expanding them into database rows, and the browser refuses a
33rd method before starting passphrase encryption or passkey registration.

## Who is affected

Users who manage encrypted Mangrove review signing keys. A pre-existing envelope
with more than 32 methods remains readable so its owner can unlock and export
the key; any replacement wrap set must contain no more than 32.

## Required action

No operator action is required. A user with a pre-existing oversized envelope
must export and regenerate the key, or replace the complete wrap set with no
more than 32 methods, before managing its unlock methods further.
