---
impacts: [breaking]
---

## What changes

The internal capabilities and integration metadata APIs now use shared response schemas and a validated generated SDK. Public integration health descriptors contain only `type`, optional `name` and optional `category`; operational URLs, headers and configuration keys are no longer returned.

## Who is affected

Custom consumers of `/api/capabilities` and `/api/integrations`. OpenMapX's bundled web client and legal pages use the new SDK in the same release.

## Required action

Custom consumers must use the current response contracts and obtain operational health configuration from their own host configuration. Deploy the web client and API from the same release. No database or configuration migration is required.
