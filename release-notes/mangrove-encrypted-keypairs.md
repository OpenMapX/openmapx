---
impacts: [breaking, migration, security, operator-action]
---

## What changes

Mangrove shared signing is the main review connection flow, with passkey, OSM and
Bluesky authorization. Operators register an exact callback URL with Mangrove and
configure `signerClientId` and `signerRedirectUri` in the integration. Without that
registration, users can choose encrypted local signing.

Local Mangrove signing keys now require encrypted storage. Plaintext setup and
private JWK fields in public-key requests are rejected. Envelope replacement and
deletion require the revision returned by the API; stale operations return 409.

## Who is affected

Development instances with existing Mangrove key envelopes. There are no deployed
users requiring a compatibility workflow.

## Required action

Apply the new `0043_mangrove_encrypted_revision` database migration. It explicitly
deletes development plaintext envelopes and their unlock-method metadata before
dropping the plaintext and mode columns. Existing encrypted envelopes remain and
receive a new revision. Export any development plaintext key you intend to keep
before applying the migration, then import it using encrypted local setup.
