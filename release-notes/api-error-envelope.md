---
impacts: [breaking]
---

## What changes

Every API error reply now has one shape, `{ error, code? }`: `error` is a short,
user-safe description and `code` an optional stable reason in UPPER_SNAKE.
Replies that carried a machine token in `error` now put it in `code` and give
text in `error`, for example `{ error: "invalid_request" }` becomes
`{ error: "Invalid handoff request", code: "INVALID_REQUEST" }`. This covers the
mobile sign-in handoff, attribution, admin coverage, admin account actions,
sign-in policy, reauthentication and capability binding refusals, POI search
and search interpretation. Codes in kebab-case or lower_snake are now
UPPER_SNAKE, among them the offline package codes (`SOURCE_UNAVAILABLE`,
`PREPARE_RATE_LIMITED`, `PRINCIPAL_QUOTA`), the transit source codes
(`IN_FLIGHT`, `DUPLICATE_IDEMPOTENCY_KEY`, `SOURCE_ACTION_NOT_ALLOWED`,
`PREFLIGHT_STALE`), the coverage codes (`SNAPSHOT_EXPIRED`, `INVALID_QUERY`),
the wildfire layer codes and `TRANSIT_CREDENTIALS_MANAGED`. Stored codes
follow the same rule: an administrative job's `errorCode` (`CONFLICT`,
`FORBIDDEN`, `CONFIGURATION_PREREQUISITE`, `CONFIGURATION_PREFLIGHT_FAILED`,
`HOST_UPDATE_REQUIRED`, `RECOVERY_REQUIRED`, `REQUIRED_SETTINGS_MISSING`), an
offline package job's `errorCode` (`INVALID_REQUEST`, `CAPACITY`,
`GENERATION_FAILED`, `EXPIRED`) and a privacy notification's last error code.
Replies that used
`message` for that text now use `error`, among them the tile, image, MapTiler,
Mapterhorn, traffic and winter-sports proxies and the overlay, weather, tide,
sun-time and street-level imagery integrations.

The air-quality and OpenStreetMap contribution errors keep their codes and their
other fields and rename `message` to `error`. Managed Dawarich, privacy
administration and privacy request errors and the wildfire layers' unavailable
reply add `error` beside their `code`. Integration and service configuration
validation adds `error` beside its `errors` list.

Error bodies no longer carry an `ok` flag; the HTTP status says that the request
failed. These replies drop `ok: false` and keep their other fields:

- the data-manager offline package job, manifest, glyph, glyph catalog and
  archive refusals (400 and 404) and the archive delivery limits (503), also
  where the API passes them through
- the data-manager search index and notable places 404 before a first build,
  the Overture status 404 and the Overture recovery 503
- the data-manager transit source reads and changes (400, 404, 409), including
  `code: "SOURCE_ACTION_NOT_ALLOWED"`, and a source change refused for lack of
  a durable receiver (503). An unexpected failure of these routes answers
  HTTP 500 `{ error: "Transit source request failed" }` and data-manager logs
  the cause; before, Fastify's default body carried the exception text
- the API's Compose shutdown guidance (503), Compose start's idempotency refusal
  (400), the admin operation 404 and its input refusal (400), which keeps
  `issues`

Success replies keep their `ok` field. So do the data-manager readiness report
(`/status`, HTTP 503 while starting) and the transit capacity preflight result
(HTTP 422 with `blockers`), which are reports rather than error bodies. The
catalog bump approval no longer documents an HTTP 422, which it never sends.

Offline package preparation errors replace `ok`, `errorCode` and `errorMessage`
with `error` and `code`, and keep `retryAfterSeconds`. The offline capability's
HTTP 502 answers `{ error, code: "SOURCE_UNAVAILABLE" }` instead of an
unavailable capability. A transit source change refused because another job
runs or its idempotency key was used, and a refused transit sync, replace `ok`
and `reason` with `error` and `code` and keep `existingJobId`. A transit sync
naming a country outside the operations profile answers HTTP 422
`{ error, code: "OUTSIDE_OPERATIONS_PROFILE" }` with the reason in `error`,
instead of the framework's `{ statusCode, error, message }`. A MOTIS restart
refused for lack of a durable receiver answers
`{ error, code: "OPS_AGENT_UNAVAILABLE" }` instead of carrying that code in
`error`. Better Auth
replies under `/api/auth/*` keep their own `{ code, message }` shape, and an
OAuth 2.0 error response keeps its RFC 6749 `error` token.

## Who is affected

Scripts or separately deployed clients that read `message`, `errorMessage`,
`reason` or `ok`, or rely on a bare `code`, in an API error body. The OpenMapX web and mobile apps change together
with the API.

## Required action

Read the error text from `error`, branch only on `code` with its UPPER_SNAKE
spelling, and tell failure
from the HTTP status rather than from `ok`. Upgrade API and
application clients together. No migration or configuration change is needed.
