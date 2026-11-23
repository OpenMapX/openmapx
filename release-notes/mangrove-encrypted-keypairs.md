---
impacts: [breaking, security, operator-action]
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

Operators who offer Mangrove reviews, and API clients that set up or change local
Mangrove signing keys.

## Required action

To offer shared signing, register the exact callback URL with Mangrove and set
`signerClientId` and `signerRedirectUri` in the integration. API clients must
send only encrypted key envelopes and pass the current revision when replacing or
deleting one.
