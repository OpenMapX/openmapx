---
impacts: [breaking]
---

## What changes

All eight personal-vehicle and parking operations now share validated contracts
and generated SDK callers. Vehicle creation returns its actual creation receipt;
read records include persisted timestamps. Vehicle and parking replies expose
public record fields without the owning account ID. Invalid successful replies
are rejected before entering account caches or completing local-to-account sync.

Request objects reject unknown fields and incorrect JSON primitives. EV inputs
use the existing connector vocabulary and explicit numeric constraints. Parking
PATCH accepts only the fields it actually updates. Existing domain normalization,
account locking, ownership, vehicle cap, default promotion, parking uniqueness,
cascading deletion, and no-store policy remain authoritative. Signed-out local
storage and first-sign-in synchronization remain supported product behavior.

## Who is affected

Direct callers of `/api/vehicles` and `/api/parking`, and separately deployed
OpenMapX web/API components. Current application callers migrate together. The
obsolete handwritten vehicle/parking URL constants are removed from the internal
endpoint map; application HTTP callers use the generated garage SDK.

## Required action

Upgrade API and application clients together. Send the documented request fields
with correct types and use the creation receipt rather than assuming timestamps
are present. Fetch the read record when persisted metadata is needed. No database
migration, compatibility layer or cache versioning is required.
