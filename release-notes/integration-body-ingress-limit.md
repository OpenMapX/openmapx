---
impacts: [security]
---

## What changes

Body-capable requests to integration-provided API routes now meet a dedicated
per-client admission limit before the API parses their payload. Requests that
are admitted still use the integration route's existing operation-specific
request limit.

## Who is affected

Installations that expose built-in or installed integration API routes.

## Required action

No immediate action is required. Installations with unusually high legitimate
integration write traffic can tune `RATE_LIMIT_INTEGRATION_INGRESS_MAX` and
`RATE_LIMIT_INTEGRATION_INGRESS_WINDOW_MS` before recreating `app-api`.
