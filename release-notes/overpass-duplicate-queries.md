---
impacts: [operator-action]
---

## What changes

The bundled Overpass service runs a query string again while it is running
or ran moments ago (`OVERPASS_ALLOW_DUPLICATE_QUERIES=yes`). The image's
default, `no`, made its dispatcher answer such a repeat with a
`duplicate_query` error page for about 30 seconds. That failed Docker's
healthcheck and `pnpm openmapx check`'s probe from time to time, since both
send the same query each time, and it failed a user's query repeated within
that window. Both dispatchers, the main one and the areas one, take the
setting. The instance is private: only app-api and the OpenConditions ingest
reach it, and app-api bounds its requests. Set
`OVERPASS_ALLOW_DUPLICATE_QUERIES=no` in `infra/docker/.env` to keep the old
behaviour.

Separately, app-api no longer turns such an error page, which Overpass sends
with HTTP 200, into a JSON syntax error. A `duplicate_query` or other
dispatcher error is reported as Overpass being unavailable, a timeout as a
timeout and a rate limit as a rate limit, as when Overpass answers with
those statuses.

## Who is affected

Every deployment that runs the bundled Overpass service.

## Required action

The setting is part of Overpass's container environment, so a render alone
doesn't apply it: recreate Overpass on the host once after updating.

```bash
pnpm openmapx services update overpass --no-deps
```

Its database persists, and the dispatchers restart. Queries fail for the
moment the service is down.
