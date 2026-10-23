---
impacts: [breaking]
---

## What changes

All five sharing operations use canonical validated contracts and generated SDK
callers. Public replies are validated before metadata or shared views render;
malformed successes become unavailable. Owner replies are validated before
entering the query cache. Creation retains its `201` receipt and token.

Requests reject unknown fields, incorrect JSON primitives and out-of-bounds
coordinates, text or schedule structures. Stored/public snapshots must satisfy
the same bounded public projection. Invalid public records use the existing
uniform not-found response. Attribution is retained, with a separate bounded
128 MiB public-list SDK allowance for the existing 1,000-place limit; other
operations retain their current decoding limit.

Public server rendering remains anonymous and `no-store`; owner responses retain
private/no-store, Pragma and Cookie variance. CORS exposes the Vary response
header so cross-origin clients can validate that cache contract. Tokens remain bearer credentials,
with only their hashes persisted. Ownership, expiry, rotation, revocation,
account locking, share caps and route-input normalization remain authoritative.

## Who is affected

Direct callers of `/api/shares` and separately deployed OpenMapX API/web clients.
Application callers move together to `@openmapx/core/sharing-sdk`.

## Required action

Upgrade API and application clients together and send the documented fields and
JSON types. No database migration or compatibility layer is required.
