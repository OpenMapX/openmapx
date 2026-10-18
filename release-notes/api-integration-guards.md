---
impacts: [security]
---

## What changes

Integration metadata, previews and cached health reads now use the public API
request limit. Integration-provided routes retain their declared request tier.
Health checks with configured custom headers require redirects to stay on the
original origin, including its scheme and port.

## Who is affected

Installations serving integration endpoints or using health checks with configured
headers, including credential-bearing headers.

## Required action

No immediate manual action is required for same-origin health checks or ordinary
API use. Review any health-check configuration that intentionally redirects to
another origin; checks with configured headers must use a same-origin endpoint.
