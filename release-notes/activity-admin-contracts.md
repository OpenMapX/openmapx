---
impacts: [breaking]
---

## What changes

The Activity administration API now validates job requests and responses against
shared contracts. Job pagination accepts safe integers: `limit` is 1–200
(default 50), and `offset` is nonnegative (default 0). Event-stream cursors must
be nonnegative safe integers. Malformed values return a client error instead
of being partially parsed, clamped or ignored.

Job payloads and results retain nested JSON fields. Objects with an own
`__proto__` key are rejected explicitly instead of silently losing that key
during validation.

## Who is affected

Custom clients calling `/api/admin/jobs` or its job-detail, cancellation,
stream-metrics and event-stream endpoints. The built-in Activity interface uses
the generated SDK and the same contracts.

## Required action

No action is required for the built-in interface. Custom clients must send
documented query values and supported JSON payloads. No database migration or
cache reset is required.
