---
title: API surface
description: How apps/api/openapi.json is generated, what it covers, and how to keep it accurate when you add a route.
sidebar_position: 12
---

# The API surface document

`apps/api/openapi.json` is a generated, committed description of **every HTTP
endpoint the API serves** — the core routes and the routes contributed by
integrations. It is regenerated in-process, without a running server, a
database, a cache, or network access, and a gate fails the build when it drifts.

The point is accountability, not developer documentation. Because it is
committed, a route that appears, disappears, changes method, or loses its
authentication requirement shows up as a diff line in review. Nothing else in
the repository makes that visible — in particular the 150+ integration routes
have no other inventory.

```bash
pnpm openapi:generate   # rewrite the document
pnpm check-openapi      # fail if it no longer matches the code
```

`check-openapi` runs in CI, and in `pre-commit` when the staged files could have
moved the surface. There is also a Vitest suite (`openapi-freshness.test.ts`)
that asserts the same thing plus two invariants: every operation declares how it
authenticates, and no `/api/admin` operation is documented as anything but
`admin`.

## What gets collected, and how

The document has two halves, gathered two different ways.

### Core routes

`registerCoreRoutes` (`apps/api/src/routes/index.ts`) is the single source of
truth for every route not contributed by an integration. The generator mounts it
on a bare Fastify instance, waits for `ready()`, and reads the route table back
through `@fastify/swagger`. Nothing listens on a port; the database and cache
clients are lazy and never connect.

**If you add a core route, register it through `registerCoreRoutes`.** A route
declared directly on the server instance in `server.ts` would be served but
absent from the document — which is why `/health`, `/api/id-schemes` and
`/api/transit/registry` live in `routes/meta.ts` rather than inline.

Whatever Fastify JSON schema a route declares (`querystring`, `params`, `body`,
`response`) flows through into the document. Most routes declare none yet, so
most operations describe a path and a method rather than a payload shape.

### Integration routes

Integration routes are not Fastify routes. `ctx.registerRoute(...)` appends to a
private table (`apps/api/src/integration-routes.ts`) that is dispatched from two
wildcard routes, so Fastify's own introspection sees `/api/integrations/:id` and
nothing else.

They are therefore read **statically**, by parsing the `registerRoute` call
sites with the TypeScript compiler API across the 105 built-in integrations.
Running every integration's `setup()` against a stub context executes arbitrary
integration code — including registry loads — inside a commit gate, so the
static scan was preferred. Both approaches independently verify the declared
integration route surface.

The consequence is a constraint: **`registerRoute` must be called with literal
method and path strings.** A computed path fails the scan with an explanatory
error rather than silently vanishing from the document.

### Shared route factories

A helper in `packages/integration-framework` can register routes on behalf of
the integrations that call it — `createTidesIntegration` does, contributing
`GET /tides` to four integrations. Those are declared in `SHARED_ROUTE_FACTORIES`
in `collect-integration-routes.ts`.

If you add another such helper, add it to that list. You will not forget
silently: the scanner fails when a framework module registers routes without
being declared.

## Declaring how a route authenticates

Every operation carries `x-openmapx-auth`. For integration routes it is read
from `registerRoute`'s `requireAuth` option. Core routes need it stated,
because guards run inside handlers or in a plugin `preHandler` hook and nothing
about them is introspectable.

State it once per plugin, next to the guard it describes:

```ts
export const savedRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "session");

  // Every /saved route is per-user; authenticate once here so no handler can
  // forget the check.
  fastify.addHook("preHandler", requireAuthHook);

  fastify.get("/saved/lists", async (req) => {
    /* ... */
  });
};
```

A single route can override the plugin-wide level:

```ts
fastify.post("/mobile-auth/issue", { config: { auth: "session" } }, handler);
```

| Level | Meaning |
| --- | --- |
| `public` | No credentials required. |
| `session` | A signed-in user session. |
| `admin` | An administrator session. |
| `service` | An administrator session **or** a service-to-service token (`/api/data-manager`). |
| `internal` | No application check — reachability is expected to be restricted by the network (`/api/internal/*`). |
| `unspecified` | Nobody has classified it. Fails the freshness test. |

`unspecified` is deliberately distinct from `public`: an unclassified route must
never be documented as open.

### Status and mobile-auth request boundaries

`GET /api/status` is the cookie-independent, redacted status representation.
It may be shared-cacheable and never includes dependency URLs, probe errors, or
refresh error classes. `GET /api/admin/status` requires an administrator session
and returns operational detail with `Cache-Control: private, no-store`. Both
representations report `snapshotAgeMs` and `stale`; stale data is bounded to five
minutes.

The two mobile session-handoff operations accept JSON bodies of at most 4096
bytes. Fastify enforces that parser limit for fixed-length and chunked requests
before either handler runs. Their schemas reject unknown keys and use these
field bounds:

| Operation | Field | Accepted value or length |
| --- | --- | --- |
| `POST /api/mobile-auth/issue` | `purpose` | `sign-in`, `link-provider`, or `add-passkey` |
|  | `codeChallenge` | 43–128 base64url characters |
|  | `state` | 16–128 base64url characters |
| `POST /api/mobile-auth/exchange` | `callbackCode` | 16–256 base64url characters |
|  | `codeVerifier` | 43–128 base64url characters |
|  | `state` | 16–128 base64url characters |

### Cookie mutation and CSRF boundary

Every application `POST`, `PUT`, `PATCH`, or `DELETE` request that carries a
`Cookie` header must also carry exactly one syntactically valid HTTP(S)
`Origin`. Its normalized scheme, hostname, and effective port must exactly
match an origin configured in `CORS_ORIGIN`. Wildcards, sibling or suffix
matches, credentials, paths, queries, fragments, custom schemes, `null`, and a
missing or repeated Origin are rejected with a generic 403 before body parsing
or route handling. There is deliberately no application-level `Referer`
fallback.

The only path exemption is exactly `/api/auth` and its `/api/auth/` subtree,
whose unsafe requests remain protected by Better Auth's own global origin
middleware. Cookie-free bearer, service-token, loopback-CLI, and anonymous
requests continue to their existing route authentication; that is an
authentication-mode branch, not a route exemption. In particular, loopback
admin mutations still require `X-OpenMapX-Local-Admin` independently of this
guard. `GET`, `HEAD`, and `OPTIONS` are unaffected.

`CORS_ORIGIN` is also the normalized web-origin source for CORS, Better Auth,
and auth UI redirects. CORS responses vary on `Origin` and never reflect an
untrusted origin. CORS is a browser response policy, not authorization, and it
does not replace the mutation guard.

## What this document is not

- **Not a response contract.** Adding a Fastify `response` schema is not
  documentation — it is `fast-json-stringify` serialization, and it silently
  drops any property you forget to declare. Response schemas are added per
  route, with tests, not in a sweep.
- **Not a request-validation project.** Adding `querystring`/`body` schemas
  moves validation ahead of the handler and changes the 400 messages clients
  see. Worth doing, route by route, as its own change.
- **Not a published API.** It describes the internal surface the web and mobile
  clients use. A stable, versioned public API is a separate design
  (`/api/v1` + SDK), and this generator is the emitter it would build on.
- **Not a description of Better Auth's endpoints.** Better Auth is mounted as a
  single wildcard handler and appears as `/api/auth/{wildcard}`.

## When the gate fails

```
✗ apps/api/openapi.json is out of date — the API surface changed.
  Run `pnpm openapi:generate` and commit the result alongside your route change.
```

Regenerate and read the diff before committing it. If the diff shows a change
you did not intend — a route you did not think you touched, or an auth level
moving to something weaker — that is the gate doing its job.

## Canonical air-quality routes

The built-in `air-quality` integration owns three public, expensive-tier routes.
They return `Cache-Control: private, max-age=0`; provider and distributed caches
reduce upstream work without turning location-specific responses into shared
browser-cache entries.

| Route | Required query | Optional query | Bounds |
| --- | --- | --- | --- |
| `GET /api/integrations/air-quality/current` | `lat`, `lng` | `countryCode`, `subdivisionCode`, `comparisonStandard` | WGS84 coordinates; uppercase ISO hints |
| `GET /api/integrations/air-quality/forecast` | `lat`, `lng` | current options plus `hours` | `hours` defaults to 48 and is 1–120 |
| `GET /api/integrations/air-quality/stations` | `south`, `west`, `north`, `east` | `zoom`, `pollutant`, `limit`, `cursor` | viewport at most 20° latitude × 30° longitude; antimeridian supported; zoom 0–22; limit 1–500 |

Every scalar key may occur once. Invalid/repeated values return HTTP 400 with
`{ code: "INVALID_QUERY", message, details? }`. A valid request with no evidence
is HTTP 200 with `status: "unavailable"`, never 204. `partial` means useful
evidence was returned while a provider, comparison, freshness, policy, or size
condition degraded the result.

Current responses name `primaryEvidenceId` independently from
`primaryIndexId`. Raw fallback deliberately sets the evidence ID and leaves the
index ID null. A requested comparison standard is secondary and cannot replace
the standard resolved from the location. Forecasts return a bounded evidence
table, stable provider series, and validity-start frames; categories are never
interpolated. Stations are GeoJSON Points, thinned deterministically to one
winner per zoom-derived Web Mercator cell.

Station cursors are signed, purpose- and query-bound references into an
immutable five-minute snapshot. They do not contain station data. Tampered or
cross-query cursors are HTTP 400; an expired snapshot/cursor or changed source
policy is HTTP 409 `CURSOR_EXPIRED`. Non-2xx canonical responses use only the
closed codes `INVALID_QUERY`, `DOMAIN_DISABLED`, `CURSOR_EXPIRED`,
`FRAME_UNAVAILABLE`, `UPSTREAM_INVALID_RESPONSE`, and
`NORMALIZED_RESPONSE_TOO_LARGE`.

The deprecated `GET /api/integrations/weather-open-meteo-air-quality/aqi`
route preserves its nine-field body. It now advertises `Deprecation`, `Sunset`,
and a canonical successor `Link`. Source-policy exclusion is intentionally HTTP
503 with exactly `{ "message": "Open-Meteo air quality is disabled by data-use policy" }`.
