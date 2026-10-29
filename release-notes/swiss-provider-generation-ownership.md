---
impacts: [breaking, operator-action]
---

## What changes

Swiss transit and its dependent SIRI adapter use isolated runtime instances.
Reloaded configuration and attribution no longer alter in-flight requests from
an earlier generation. Downloads use bounded host HTTP transport.

Authenticated Swiss API refreshes now enforce the published quotas through the
shared Redis-backed upstream runtime. Without an available shared runtime or
remaining quota, no fresh authenticated request is made. Valid cached results
retain their existing TTLs; public static datasets remain available independently.
Custom authenticated API endpoints must use HTTPS without credentials in the URL.

Learned route observations remain shared across matching replicas and reloads.
Their cache identity includes configuration and receipts, and invalidation also
rejects late observations from requests started before the clear.

## Who is affected

Installations using the Swiss transit or Swiss SIRI integrations, especially
installations without Redis or with custom HTTP API endpoints.

## Required action

Provide the normal shared Redis service for authenticated Swiss API acquisition.
Check any custom Swiss API endpoint overrides use HTTPS. There is no database
migration, credential format change or data conversion.
