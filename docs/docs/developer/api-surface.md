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
sites with the TypeScript compiler API across the 106 built-in integrations.
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

| Level         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `public`      | No credentials required.                                                                             |
| `session`     | A signed-in user session.                                                                            |
| `admin`       | An administrator session.                                                                            |
| `service`     | An administrator session **or** a service-to-service token (`/api/data-manager`).                    |
| `internal`    | No application check — reachability is expected to be restricted by the network (`/api/internal/*`). |
| `unspecified` | Nobody has classified it. Fails the freshness test.                                                  |

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

| Operation                        | Field           | Accepted value or length                     |
| -------------------------------- | --------------- | -------------------------------------------- |
| `POST /api/mobile-auth/issue`    | `purpose`       | `sign-in`, `link-provider`, or `add-passkey` |
|                                  | `codeChallenge` | 43–128 base64url characters                  |
|                                  | `state`         | 16–128 base64url characters                  |
| `POST /api/mobile-auth/exchange` | `callbackCode`  | 16–256 base64url characters                  |
|                                  | `codeVerifier`  | 43–128 base64url characters                  |
|                                  | `state`         | 16–128 base64url characters                  |

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

## Generated runtime metadata SDK

`GET /api/capabilities` and `GET /api/integrations` have shared Zod response
contracts in `@openmapx/core/api-contracts`. Their real Fastify response schemas
feed named OpenAPI components. Other inventory-only endpoints are adopted in
separate families when their actual wire contracts have been specified.

After changing these contracts, run `pnpm openapi:generate`, then
`pnpm sdk:generate`. Commit both the OpenAPI diff and generated SDK diff.
`pnpm check-api-sdk` checks the complete generated file set without rewriting it
and runs in the policy gate. Generation uses the committed OpenAPI document,
selects the `runtime-metadata` family before validation, and performs no provider
or database acquisition. Unrelated inventory entries are not SDK input.

Import operations from `@openmapx/core/api-sdk`. Pass an isolated `ApiClient`
through the operation's options for server/native or independently configured
browser acquisition. The generated integration operation also accepts typed
conditional request headers as its first argument. Its result distinguishes
`200` with metadata from bodyless `304`. The transport owns credentials,
cancellation through body consumption, deadlines and bounded redacted HTTP
errors; the generated validator owns the response shape. Contract errors do
not expose validation inputs. Legal pages use one `cache: "no-store"` snapshot.

The pinned Orval configuration enables reusable recursive Zod schemas and
selects generated **output** types for validated custom-client responses using
its supported output transformer. Both are required to preserve recursive
catalog types. Do not remove them without running SDK type/behavior tests.
Public integration health metadata contains `type`, optional `name` and
optional `category`; operational URLs, headers and configuration keys stay
inside the host. Source licensing uses the portable structured output schema.

## Generic weather forecasts

`GET /api/integrations/weather/forecast` returns independent `hourly` and `daily`
`WeatherForecastResponse` envelopes. Each envelope contains `points`, the exact
selected `source`, and captured `contributors` projected from its returned
points. Hourly and daily fallback can select different suppliers. A successful
empty forecast keeps its selected source with empty points and receipts; when
no provider succeeds, the source is `null` and both arrays are empty.

Each forecast point retains its own canonical `contributors`, including
authoritative `[]`, so clients can project credits after filtering or selecting
points. The orchestrator captures the lookup catalogue before each provider
acquisition and resolves only the response's explicit source or supplied
receipts. Cached responses keep that acquisition metadata; they never rebuild
credits from the current integration catalogue. The versioned forecast cache
namespace excludes older bare-array payloads.

The cache identity also includes the current disallowed-source set so a policy
change reacquires an eligible fallback. If an adapter identifies its selected
feed only in the response, the orchestrator rejects a disallowed returned
source before exposing it. Such adapters still enforce acquisition policy
internally. The host response filter remains the final authority: a policy
change after handler resolution can replace a source-tagged envelope with
`null`, as for other source-tagged API results.

## Canonical air-quality routes

The built-in `air-quality` integration owns three public, expensive-tier routes.
They return `Cache-Control: private, max-age=0`; provider and distributed caches
reduce upstream work without turning location-specific responses into shared
browser-cache entries.

| Route                                        | Required query                   | Optional query                                         | Bounds                                                                                        |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GET /api/integrations/air-quality/current`  | `lat`, `lng`                     | `countryCode`, `subdivisionCode`, `comparisonStandard` | WGS84 coordinates; uppercase ISO hints                                                        |
| `GET /api/integrations/air-quality/forecast` | `lat`, `lng`                     | current options plus `hours`                           | `hours` defaults to 48 and is 1–120                                                           |
| `GET /api/integrations/air-quality/stations` | `south`, `west`, `north`, `east` | `zoom`, `pollutant`, `limit`, `cursor`                 | viewport at most 20° latitude × 30° longitude; antimeridian supported; zoom 0–22; limit 1–500 |

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

## Internal data-manager service

`services/data-manager/openapi.json` describes all explicit internal operations,
including progress streams, binary downloads and HEAD responses. It is collected
from the actual `registerApi` route registrations without starting jobs or
connecting to a database. Optional offline-package routes are included using an
inert collaborator. Automatic HEAD routes are excluded; explicit HEAD operations
remain part of the contract.

The canonical Zod operation table lives in
`packages/core/src/services/data-manager/contracts`. It owns method, path,
authentication, request validation, response statuses, wire schemas and required
headers. Register producer handlers through `registerDataManagerRoute` so runtime
validation and documentation use that same definition. Validate each hijacked
NDJSON event before writing it; these streams bypass Fastify serialization.

```bash
pnpm data-manager:openapi:generate
pnpm data-manager:sdk:generate
pnpm check-data-manager-openapi
pnpm check-data-manager-sdk
```

The last two commands run in `check:policy`. Commit both the document and generated
SDK when changing a contract. Orval generates request serialization and plain wire
types; operation-bound transport closures select the canonical runtime validators.
Do not edit generated files or introduce a separate handwritten endpoint map.

Server consumers import `@openmapx/core/data-manager-sdk`, explicitly construct a
transport with their service URL and credentials, and call its generated functions.
The transport enforces destination policy, deadlines, response sizes, declared
statuses, media types, headers and payloads. Workflow adapters consume bounded,
validated NDJSON progress and require a terminal event. Binary operations return an
unconsumed `Response`; callers own streaming and release. This internal SDK must
never receive browser credentials or replace the browser-facing API client.

## Browser-facing data-manager administration

The application API has a separate `data-manager-admin` contract family covering
all 19 `/api/data-manager` operations and six `/api/admin/ambient-places`
operations. Its portable schemas live under
`packages/core/src/api/contracts/data-manager-admin`; API-owned database, Redis,
operations-agent and merged-catalog projections are defined there rather than
pretending they are internal data-manager responses.

Register these handlers through `registerDataManagerAdminRoute` and keep their
actual authentication guards beside the corresponding declarations. Authentication
metadata does not grant or enforce access. The collector checks all 25 actual
registrations, their stable operation IDs, status schemas and authentication
classifications. Shared schema emission supports Fastify's draft-7 runtime and the
OpenAPI 3.1 document without maintaining parallel handwritten schemas.

```bash
pnpm openapi:generate
pnpm sdk:generate
pnpm check-openapi
pnpm check-api-sdk
```

Browser callers import `@openmapx/core/api-admin-sdk`. Generated named operations
use `ApiClient` for the configured API origin, cookies, cancellation and deadlines.
Their bound transport validates each declared status and its canonical JSON schema
within response-size limits. `unwrapAdminResponse` returns successful data or a
structured, redacted `ApiClientError`. Handle an expected absence such as an index
status `404` before unwrapping; it is distinct from a malformed response or a
successful published index. Query keys, polling and invalidation remain owned by
the browser feature.

The metadata and administration clients are generated together, with independent
schema selection and one exact artifact-set check. Mechanical file emission and
operation binding are shared with the internal SDK. Neither browser client uses
internal service credentials or data-manager destinations.

## Activity administration

The `activity-admin` family adopts exactly five core operations: list jobs, inspect
one source-qualified job, cancel an application job, read stream metrics and open
an application-job SSE connection. `activityAdminOperations` in
`@openmapx/core/api-contracts` supplies their request/response schemas. Routes use
the shared administration registrar after their inherited admin guard; the older
data-manager family retains its existing validation phase and hooks.

The list query defaults to `limit=50` and `offset=0`; optional pagination accepts
only bounded safe decimal integers. Detail and cancellation distinguish
`application` and `data-manager` sources. Complete wire jobs include ISO dates,
recursive JSON payload/result values, actors in list rows, logs and data-manager
stages. Invalid output is rejected before Fastify can silently drop fields.

Import the generated operations from `@openmapx/core/api-admin-sdk`. Finite
operations return status-qualified validated responses. `streamAdminActivityJobEvents`
returns an `AdminEventStreamTarget` with `url` and `withCredentials`; construct
native `EventSource` in the browser and retain ownership of its lifetime. It does
not fetch or parse SSE as JSON. The optional query cursor resumes an initial
connection; native reconnections use `Last-Event-ID`, which takes precedence.
Validate each received frame with `adminJobStreamEventSchemas` before applying it.

The raw producer validates snapshots and every event before writing. Both the
snapshot priming backlog and unflushed writes are bounded to 200 per viewer;
overflow emits a qualified control event and closes. Invalid post-hijack state
closes without exposing producer content, unsubscribes and clears heartbeat timers.
Regenerate both `pnpm openapi:generate` and `pnpm sdk:generate` after a contract
change, then run `pnpm check-openapi` and `pnpm check-api-sdk`.

## Integration administration

`integrationAdminOperations` owns all 22 integration, binding, credential and
`/api/admin/overview` operations. Import the generated functions and canonical
wire types from `@openmapx/core/api-admin-sdk`. The focused producer plugins inherit
the administrator guard before contract parsing. Binding POST retains its earlier
body-validation-before-handler-auth ordering. JSON parsing, global CSRF and rate
limits retain their existing lifecycle positions. An omitted optional mutation
body stays absent; explicit JSON null is invalid.

Manifest/config-schema JSON remains lossless. Credential status uses the actual
resolved winning layer, with stored-vault audit fields reported separately and
without values. Health-history hours default to 24 and accept one integer from
1 through 168. SQL timestamp-without-time-zone hour values are interpreted as UTC
and emitted as ISO timestamps. Reload enqueue responses are HTTP 200 `{ok, jobId}`;
they do not establish terminal job success.

Configuration import validates the complete file against current manifests before
writes. It replaces named non-secret overrides, preserves an omitted `enabled`,
and leaves unnamed rows and the vault untouched. Declared top-level secret fields
are omitted. Unknown/read-only/invalid fields and masked non-secret values reject
the file. Exports omit secrets, obsolete/unknown DB fields and read-only fields;
their optional `exportedAt` and `count` metadata is accepted by import. Empty imports
are rejected, including an empty export with no saved overrides.

Validation errors identify bounded entry numbers, known integration/field names
and public rule categories. They never include supplied values, unknown keys,
raw schema values or internal validator details.

One DB transaction persists the batch. Before preparing the complete input, the
API observes the current host revision through typed `configuration.inspect`;
the initial `stack.render` must still own that revision at activation. A completed
competing writer causes a conflict, with no automatic mutation retry. One normal
reload follows a successful apply. A failed import returns HTTP 409 with
`ok: false`, `phase`, `recovery`, `database`, optional `runtime`, and optional
`apply`/`compensation` outcome evidence. `recovery: "restored"` is still a failed
import, not success. `reconciliation_required` means an operator must inspect
saved, applied and runtime state before another deliberate action; do not retry
a mutation automatically. No secret-bearing snapshot enters this response.

Recovery compares each named row's identity and PostgreSQL tuple version in an
all-or-none transaction. It reverses only those integrations in the full payload
actually submitted, preserving unrelated changes included during preparation.
Before using previous DB rows as an inverse, recovery compares their named
projections against fingerprints from that same authoritative host observation.
Missing evidence or prior saved/applied divergence returns
`reason: "previous_applied_not_proven"`, retains the imported DB rows, and requires
reconciliation without replaying unproven values. The observation exposes no
configuration values or secrets. An initial host conflict also requires
reconciliation even if owned DB rows were restored: the competing generation may
have included some of the imported settings.

Host compensation authenticates `expectedCurrentRevisionId` using the committed
import revision. A newer host generation conflicts rather than being overwritten.
After a reload exception, a successful DB/host restoration also needs a recovery
reload and a final DB ownership check. Unknown completion, lost ownership,
compensation failure and incomplete cleanup remain explicit reconciliation.
This is request-local compensation, not a crash-atomic DB/host/runtime transaction;
process loss can require operator reconciliation. Live PostgreSQL and deployment
acceptance are separate from provider-independent fixture qualification.

Ordinary browser mutation completion effects capture the executing client and
integration/credential owner. Replacement origins, identities and unmounted views
cannot receive old callbacks, input clearing or feedback. Successful work can
refresh its originating caches. Disposing the view does not cancel accepted host
work; reload acceptance remains separate from Activity terminal completion.

## Extension administration

`extensionAdminOperations` owns all eleven catalog, installed-extension, preview,
install/update/remove, source and refresh operations. Producers use the shared
administration registrar after the inherited admin guard. The independent
extension preview limiter and the shared install/update store limiter run before
structural validation; global CSRF, public rate limits
and JSON parsing retain their lifecycle positions.

Import the generated functions and canonical wire types from
`@openmapx/core/api-admin-sdk`. Catalog list and detail are distinct projections;
unfamiliar nested JSON remains inert and lossless, and unknown versions remain
absent. Installed rows expose ISO timestamps and optional registry enrichment.
Preview responses retain all effective ports, the inspected repository commit,
full security rating and confirmation fingerprint. Install, update and remove
return HTTP 202 `{jobId}` acceptance; Activity observation owns terminal outcomes.
Mutations are never retried automatically.

Requests reject unknown keys, wrong types and explicit JSON null. Update may
omit its body; remove and refresh accept absence or an empty object. Selectors
retain ID precedence when both are supplied. Source strings retain exact identity;
URL, trust, provenance, revocation, persistence and host authorization remain domain
responsibilities. Regenerate OpenAPI then SDK and run both freshness checks after
contract changes.

Direct manifest URLs use the real safe-fetch path and full portable manifest
validation, then apply revocation and platform policy to the validated identity.
They always resolve at community trust. Catalog resolution retains ID, declared
version, digest and immutable verified authorization checks. All critical entries
block preview/install/update and worker execution until cleared; `maxVersion`
remains display-only metadata. Removal stays available. Existing stale-feed
reporting and cached denial semantics are preserved.

Preview has its own one-token/30-second network-key bucket. Install and update
retain their shared bucket at the same limit; other store callers are unchanged.
The guard still runs before the limiter and canonical structural validation.
Deliberate confirmation may follow preview immediately; neither HTTP operation
is automatically retried.

Extension-store validation errors select fixed public categories. Unknown
provider, JSON, staging and source-persistence failures use fixed operation
messages; route diagnostics contain only the operation message and safe error
class. Never return or log arbitrary dependency messages, URLs, schema values or
filesystem paths. Detail resolution failure retains its 200/empty-component
fallback with safe diagnostics. The canonical wire schemas and generated SDK
signatures are unchanged by these domain corrections.

The browser extension consumer uses the generated family and canonical inferred
contracts, including separate catalog list/detail projections and inert unknown
JSON metadata. Its keys retain the raw configured API identity, including an empty
same-origin value or trailing slash; only transport URL construction resolves the
empty value against the document origin. Configured API bases must be HTTP(S)
origins, without path prefixes, query strings or fragments. No global client is
reconfigured. Queries consume cancellation through response bodies with a 30-second
deadline; preview, mutation resolution and force refresh use 180 seconds and never
retry automatically. Native EventSource observation has an independent lifetime.

`AdminJobEffectsProvider` in the administration layout owns the shared accepted-job
observer. Service and extension adapters capture client, raw API identity, job ID
and feature terminal effects inside the executing mutation. View disposal suppresses
UI callbacks without losing accepted work. Provider/origin replacement retires old
registrations, including A-to-B-to-A replacement. Terminal extension effects cancel
one union of affected origin-scoped extension, service, integration/configuration,
credential inventory, runtime and overview reads before invalidating them; inactive queries remain stale
and unrelated API origins are untouched. Synchronous source edits and refresh also
invalidate catalog/detail/installed snapshots and installed badges.
