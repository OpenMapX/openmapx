---
impacts: [breaking, security, operator-action]
---

## What changes

The API no longer has a local administrator shortcut. A request from the API's
loopback address with the `X-OpenMapX-Local-Admin` header used to count as an
administrator without a session. Every admin request now needs a signed-in
administrator's session, and audit entries always name that administrator.
`OPENMAPX_LOCAL_ADMIN_TOKEN` and `OPENMAPX_DISABLE_LOCALHOST_AUTH` are removed.

`pnpm openmapx ext browse|list|preview|install|update|remove` authenticate
like `pnpm openmapx system update`. Each takes `--session-file <path>`: a
private file (owned by you, mode `0600`, one link) that contains only a signed-in
full administrator's Better Auth session cookie. The cookie goes only to the
HTTPS API origin, `https://DOMAIN` unless `--api-origin` names another, and
redirects are refused. `--allow-loopback-http` permits plain HTTP to a loopback
origin for development; changing requests then need that origin in the API's
`CORS_ORIGIN`, as the development `apps/api/.env.example` now lists
`http://127.0.0.1:3001`. `OPENMAPX_API_URL` and `API_URL` are no longer read, so
the default `http://localhost:3001` destination is gone. A missing `DOMAIN` or
an origin without a scheme is now reported as such instead of as an
unavailable API.

## Who is affected

Operators who use `pnpm openmapx ext` or scripts that call admin endpoints with
the local-admin header.

## Required action

Remove `OPENMAPX_LOCAL_ADMIN_TOKEN` and `OPENMAPX_DISABLE_LOCALHOST_AUTH` from
`infra/docker/.env`. Run `ext` commands with `--session-file`, using the same
private session file `system update` takes (see Upgrading). Scripts that called
admin endpoints with the header must send an administrator's session cookie
instead.
