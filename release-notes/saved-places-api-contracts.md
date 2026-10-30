---
impacts: [breaking]
---

## What changes

All fourteen saved-place API operations now have shared validated contracts and a
generated application SDK. Mutation replies are typed as their actual receipts:
updates return an acknowledgement, and creations return creation details rather
than a complete read record. Custom-list icons can now be cleared with JSON null,
as the existing editor requests. Label reads explicitly expose their public fields
without the owning account ID.

Application request validation no longer coerces strings into numbers or booleans.
Sort orders must be database-range integers. Imports validate structured captured
attribution and their existing receipt-count/byte limits before writing. Successful
responses with invalid record shapes fail at the boundary instead of entering the
client cache. Export downloads validate attachment/media metadata against the
requested format and enforce a configurable 40 MiB default download limit; the web
adapter supplies a 60-second default deadline.

## Who is affected

Direct callers of `/api/saved` and separately deployed OpenMapX web/API components.
The complete current web flow is migrated with the server. Previously generated
metadata, data-manager and administration families retain their contracts.

## Required action

Upgrade the API and its application clients together. Direct callers must send
correct JSON primitive types and use the operation's receipt shape; fetch a read
record separately when needed. Callers requiring larger exports may explicitly
raise the SDK download budget. No database migration, compatibility mode or cache
version migration is required.
