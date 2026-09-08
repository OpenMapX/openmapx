---
title: Monitoring & logs
description: Status dashboard, transit provider health, Prometheus metrics, service and application logs, and the admin audit trail.
sidebar_position: 6
---

# Monitoring, health & logs

When something feels off, this is where you look. OpenMapX keeps four
operator-facing views of how the instance is doing: a **status dashboard** for
"is everything reachable?", a **provider health** surface for the transit and
mobility chain, **logs** — both per-service container logs and the platform's
own application log — and an **audit log** that records every admin action.
Underneath the UI sits an OpenTelemetry metrics pipeline you can scrape with
Prometheus.

One background writer gets its own section: the live road-conditions cycle has
no UI at all, and the closures it bakes into the routing graph are visible only
through the data-manager's log and a single endpoint.

This page walks each of them and points at the code or env var behind the
behavior, so you can verify and tune rather than guess.

## Status dashboard

`/status` is the public system-health snapshot — a quick "is everything up?"
check across the pieces the instance depends on, linked from the admin
**Overview** page. It calls `/api/status`, which reports `up`, `down`, or `not
configured` with a measured response time. This public representation never
varies by session cookie and omits target URLs, dependency errors, and refresh
error detail. Administrators can retrieve those fields from the separately
authenticated `/api/admin/status` endpoint; that response is always marked
`private, no-store`.

Two groups of checks run:

- **Infrastructure and external services**, probed directly: PostgreSQL (a
  `SELECT 1`), Redis (a `PING`), the GitHub API (used by the catalog and store),
  and SMTP (a TCP connect to the configured mail host). A dependency with no
  configuration — no `REDIS_URL`, no `SMTP_HOST` — reports **Not configured**
  rather than down, so a deliberately-omitted optional service doesn't show as a
  failure.
- **Integration health checks**, drawn from each enabled integration's manifest.
  The status endpoint reads the latest results produced by the background
  health scheduler instead of probing providers on every public request. This
  avoids spending API quota merely because someone opened or refreshed the
  status page. An administrator can still force a fresh sweep from the
  integrations health view.

The page groups results by category (Infrastructure first) and shows a running
count of operational / down / not-configured services. Toggle **Auto-refresh**
to refresh the view every 30 seconds while the tab is visible, or hit
**Refresh** on demand. Requests within 30 seconds reuse one process-local
snapshot, and concurrent refreshes share one dependency probe fan-out. The
public response is additionally cacheable for 15 seconds, with 45 seconds of
stale-while-revalidate, and has a dedicated per-IP limit of 60 requests per
minute.

If a refresh fails, the API may serve the last successful snapshot for at most
five minutes with `stale: true` and `snapshotAgeMs` reporting its monotonic age.
Wall-clock adjustments cannot extend this window. After five minutes the API
returns an unavailable representation with an empty service list, rather than
exposing outdated dependency detail. Integration results advance when the
background scheduler publishes its next snapshot, unless an administrator
forces a sweep.

The same snapshot also rolls up into the admin **Overview** dashboard's
attention list; see [Admin panel](./admin-panel.md) for that landing view.

:::note[Status vs. service catalog]
The status dashboard reports *reachability* — can the API talk to each
dependency right now. It is not the Docker control plane. To start, stop, or
inspect a container's lifecycle state, use the service catalog under
`/admin/services`; see [Services administration](./services-administration.md).
:::

## Transit provider health

The transit and mobility chain has its own health surface, because it fans out
across many upstream providers (regional transit APIs, MOTIS, GBFS feeds, POI
sources) and a single bad provider shouldn't drag the rest down. It lives on
`/admin/transit` as the **Provider health** table, at the bottom of the transit
pipeline page.

Every provider call the orchestrator makes — success or failure, with measured
latency — is recorded into a **Redis-backed sliding window**, one per provider.
From that window the table shows:

- **OK / Fail** — cumulative success and failure counts since the provider was
  first seen.
- **Window fail %** — the failure rate over the recent window, color-coded
  (green below 10%, amber to 50%, red above). This, not the lifetime totals, is
  what drives auto-disable.
- **EMA latency** — an exponential moving average of call latency in
  milliseconds.
- **Status** — `active`, or `disabled until <time>` when the provider is in
  cooldown, with the disable reason on hover. The most recent failure reason is
  shown inline under the provider id.

When a provider's windowed failure rate crosses the threshold (and the window
has enough samples to be meaningful), the orchestrator **auto-disables** it for a
cooldown period and skips it on subsequent requests — the rest of the chain keeps
serving. After the cooldown the provider is tried again automatically. The
defaults:

| Parameter               | Default    | What it does                                              |
| ----------------------- | ---------- | --------------------------------------------------------- |
| Window size             | 100 calls  | Capped sliding window per provider.                       |
| Failure-rate threshold  | 50%        | Window failure rate must exceed this to auto-disable.     |
| Minimum sample size     | 10 calls   | Below this the threshold isn't evaluated (no cold-start flapping). |
| Cooldown                | 5 minutes  | How long an auto-disabled provider is skipped.            |
| EMA smoothing (α)       | 0.2        | Latency moving-average weighting.                         |
| Redis TTL               | 30 days    | Refreshed on every write; idle providers eventually expire. |

State is keyed in Redis as `provider:health:<providerId>`, so you can inspect it
directly — `redis-cli GET provider:health:<id>` returns the JSON window. Because
it lives in Redis, sibling API processes share one view and the window survives a
restart. Health tracking is observability only: if Redis is unavailable, recording
fails quietly and never breaks a user's request.

The **Reset** button per row clears a provider's window and cooldown — useful
after you've fixed an upstream credential or endpoint and want to stop skipping
it immediately rather than waiting out the cooldown. The same three operations
are available on the API for scripting (admin session **or** the data-manager
service token; the reset mutation requires a logged-in admin):

| Method | Path                                    | Purpose                                  |
| ------ | --------------------------------------- | ---------------------------------------- |
| GET    | `/api/data-manager/providers`           | Every provider's current health summary. |
| GET    | `/api/data-manager/providers/:id`       | The full window for one provider.        |
| POST   | `/api/data-manager/providers/:id/reset` | Clear that provider's window + cooldown. |

The rest of the transit pipeline page — Transitous sync state, per-feed import
status and expiry, and the recent and in-flight jobs — is covered in
[Public transit](../features/public-transit.md).

## Metrics

The transit and routing provider chains are instrumented with **OpenTelemetry**
and exported in **Prometheus** text format. Alongside each provider-health write,
the orchestrator bumps two transit instruments:

- `transit_provider_calls_total` — a counter, one increment per provider call.
- `transit_provider_call_duration_ms` — a histogram of per-call latency.

Both carry the same labels: `provider_id`, `method` (the orchestrator operation),
and `outcome` — a closed set of `ok`, `empty` (succeeded but returned nothing),
`error`, and `skipped` (the call was pre-empted by a health cooldown, a capability
mismatch, or a bounding-box miss). No label carries user input, so the series
cardinality is bounded by your provider catalogue.

Routing requests add a second set of instruments:

- `routing_requests_total` and `routing_request_duration_ms` — request count and
  end-to-end latency, labelled by provider, mode, operation, outcome, live-traffic
  use, and closure avoidance.
- `routing_route_count` and `routing_alternate_count` — the number of routes the
  selected provider returned, and the number beyond the primary route.
- `routing_traffic_delay_seconds` — the signed live-duration minus baseline-duration
  delta. Negative values mean the live route was faster than its baseline.
- `routing_baseline_available_total` — whether the provider returned a usable
  baseline duration for comparison.

For a deployment-level smoke test, run `pnpm check-routing-canaries`. It checks
stable endpoint pairs and only asserts route availability, usable durations, and
the minimum route count; it deliberately does not require a live route to be
slower than its baseline or require every graph to produce the same number of
alternatives. Set `ROUTING_BASE_URL` to probe a non-public deployment.

Scrape them at:

```
GET /api/internal/metrics
```

:::warning[Keep the metrics endpoint internal]
The endpoint emits no PII, but the labels reveal operational topology — which
providers exist and how much traffic each one sees. It is meant to be reachable
only from inside the Docker network. The bundled Traefik configuration rejects
`/api/internal/*` from outside that network with HTTP 403 via the
`internal-deny` middleware. If you want external scraping, add a separate
authenticated route rather than removing this middleware.
:::

A ready-to-import Grafana dashboard ships in the repo at
`infra/docker/dashboards/transit-providers.json` — calls per second by provider
and outcome, latency percentiles, windowed failure rate, and a count of currently
cooled-down providers. Point a Grafana at a Prometheus that scrapes the endpoint
above and import the JSON.

## Logs

There are two log surfaces, and they answer different questions.

### Service container logs

For "what is this backend service doing right now," open a service's **Logs** tab
(or the **Logs** button) under `/admin/services/<id>`. It streams that container's
output live, tailing the most recent lines — the same output as the equivalent
`services logs` CLI command, in the browser. This is the place to watch a build
finish or diagnose a container that won't come up. Full coverage is in
[Services administration](./services-administration.md).

### Application logs

For the platform's own logs — the API gateway and integration code, not a
specific container — open `/admin/activity` and switch to the **Application Logs**
tab. It renders the API's structured (pino) log stream with a console-style view:
timestamp, level, source, and message, with any structured metadata appended.

Filter by **level** (the filter is a floor — pick `warn` and you see warnings and
above), by **source** (the emitting subsystem), and by **time range**, plus a
free-text search. Auto-refresh polls every five seconds and follows the tail; pause
it to scroll back. Two things worth knowing about retention:

- Recent logs at every level live in an **in-memory ring buffer** (the most recent
  ~10,000 entries), so the viewer is fast but a restart clears them.
- `warn`, `error`, and `fatal` lines are additionally **persisted to the database**
  (the `app_logs` table) so the important events survive a restart.

New application-log entries pass through the same bounded sanitizer before the
in-memory buffer and database. Request lifecycle entries contain only an internal
request ID, method, matched route template, status, duration, and safe error class.
External URLs are represented by a normalized hostname and a SHA-256 digest
prefix for correlation; credentials, paths, queries, and fragments are not
retained.

### Purging historical application logs

Logs created before this protection was deployed may already contain sensitive
URLs. Upgrades do not delete them automatically: retention is an operator policy,
and an automatic purge could destroy evidence or records your organization must
keep. First make and verify a database backup, review your legal and incident-
response retention requirements, and record the UTC deployment time of the
protected API. In your normal PostgreSQL administration client, preview and then
delete only rows older than that operator-chosen cutoff:

```sql
SELECT count(*)
FROM app_logs
WHERE created_at < TIMESTAMPTZ '2026-08-25 00:00:00+00';

BEGIN;
DELETE FROM app_logs
WHERE created_at < TIMESTAMPTZ '2026-08-25 00:00:00+00';
COMMIT;
```

Replace the example timestamp with your deployment cutoff. Confirm the previewed
row count before `DELETE`; the operation is irreversible without the backup. To
retain a forensic copy, restrict access to the backup according to the same or
stronger policy as the live database. There is intentionally no environment flag
that restores raw request or URL logging.

The viewer is read-only — it's for triage, not configuration.

## Live road conditions in the routing graph

When `OPENCONDITIONS_URL` is set, the data-manager runs a live-traffic cycle
(`TRAFFIC_LIVE_CRON`, default every two minutes) that folds road conditions —
closures and temporary speed limits — straight into the Valhalla traffic file
the router reads. This is a background writer with no UI of its own, so its two
observation surfaces are the data-manager's container log and one small
endpoint. Both are described below.

### What the writer puts into the graph

For every condition that survives its filters, the cycle rewrites the affected
directed edges in `traffic.tar`:

- A **closure** becomes a genuine Valhalla *closed* record — a valid record
  (both breakpoints `255`) whose overall speed is `0`. Costings refuse a closed
  edge, so the router detours around it natively; only a request that opts into
  `ignore_closures` drives through.
- A **temporary speed limit** becomes a cap: the edge is written at
  `min(live speed, the condition's limit)`. A cap on an edge with no live speed
  is written on its own.
- On one edge a closure always outranks a cap, and between two caps the lower
  one wins.

Three filters decide whether a condition reaches an edge at all:

- **Binding confidence.** Only bindings OpenConditions marked `exact` or
  `likely` may move an edge. The feed also publishes `ambiguous` bindings; those
  are fine to display but are never written.
- **Origin.** Feed-sourced conditions are written as they arrive. A
  crowd-sourced report additionally has to be marked routing-eligible by
  OpenConditions' own trust model.
- **Vehicle class.** A closure scoped to classes that exclude ordinary cars — a
  lorry-only ban, say — is not written as an edge closure, because it does not
  close the road for the traffic being routed. Such an event stays on the
  point-exclusion path instead.

The writer owns expiry: Valhalla never ages out live values by itself. Every
edge written last cycle and not written again this cycle is cleared back to "no
live data", so a lifted closure or an expired cap disappears within one cycle.

### How a closure is narrowed to the edges it really covers

A bound condition arrives as one or more *spans* — a directed OSM way plus the
occupied fraction of it, with the cut geometry. Closing the whole way would shut
kilometres of motorway for a two-hundred-metre incident, so the cycle traces
each span's geometry against `TRAFFIC_VALHALLA_URL`'s `/trace_attributes` and
keeps only the returned edges that also appear in this deployment's way→edge
map, on the same way and in the bound direction.

- Cross-checked edges accepted → the span is applied **edge-exactly**.
- Nothing acceptable came back, or the span had no usable geometry → the cycle
  falls back to **every edge of the way in the bound direction**. That
  over-closes, but it never under-closes.

Trace verdicts are cached in `traffic/span-edges-cache.json` under the
data-manager's data directory, and pruned each cycle down to the spans still
being reported, so lifted closures fall out of the file. Two things are
deliberately *not* cached, so a bad minute cannot pin a span to the whole-way
fallback for the rest of its life: a transport failure (the routing container
unreachable, slow, or answering with an error), and a span left untraced because
the pass hit its 30-second tracing budget. Both are retried on the next cycle.

### The applied set

The router still has its own, coarser mechanism for closures: point-based
exclusions handed to Valhalla per request. Applying both to the same event would
be redundant and would needlessly narrow the alternatives the router can offer,
so the writer publishes what it has already baked into the graph:

```bash
curl -s http://localhost:4000/traffic/conditions/applied | jq
```

```json
{
  "writtenAt": "2026-09-07T09:14:02.511Z",
  "observationIds": ["…"],
  "resolverVersion": "…"
}
```

The route needs no bearer token — it is derived from public road-conditions
feeds and is polled on the routing hot path. Until the first successful live
cycle it truthfully answers `writtenAt: null` with an empty list, and on a
deployment where `OPENCONDITIONS_URL` is unset — live traffic not configured —
it answers `501`. An observation is listed only when
**every** one of its override edges was actually written; if a single edge could
not be resolved, the whole observation is withheld.

Two limits are worth knowing. An applied closure is a fact about the graph, not
about a departure time: a route planned for after the closure has ended still
detours around it, whereas the point exclusions it replaces did honour the
event's schedule. And the set asserts only that the *writer* wrote the record,
not that the router has reloaded the tar — a Valhalla restart that fails after a
`traffic.tar` rebuild is the one case the freshness window does not catch.

The routing integration polls this endpoint (through `DATA_MANAGER_URL`, default
`http://localhost:4000`; compose sets the service DNS name) and caches the
answer for 60 seconds. It drops its own point exclusions only for ids in a set
whose `writtenAt` is less than ten minutes old. If the endpoint is unreachable,
errors, or the set is stale, nothing is skipped and point exclusions keep
working — the writer's liveness is the only switch, there is no flag to set.

### Log lines to watch

All of these come from the data-manager container
(`pnpm openmapx services logs data-manager`, or its **Logs** tab in the admin
panel).

| Line                                                                      | Means                                                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traffic-live: conditions applied`                                        | The healthy per-cycle summary: `closedEdges`, `cappedEdges`, `overridesUnresolved`, `requestedClosures`, `appliedConditions`, `edgeExactSpans`, `wholeWaySpans`, `missingWays`, `skipped`. |
| `traffic-live: span tracing`                                              | Tracing counters for the cycle: `traced`, `unanswered`, `negative`, `skippedBudget`, `cacheHits`, `edgeExactSpans`, `wholeWaySpans`.                |
| `traffic-live: bound ways missing from way→edge map, scheduling refresh`  | Conditions referenced ways this deployment's map does not know; a way→edge rebuild was kicked off (at most hourly). Persistent counts mean the graph and the feed's road spine are on different OSM vintages. |
| `traffic-live: conditions fetch failed, reusing last good set`            | OpenConditions was unreachable; the previous set is still within `TRAFFIC_CONDITIONS_STALE_MS` and stays applied.                                   |
| `traffic-live: conditions fetch failed and last set is stale, dropping closures` | The outage outlasted `TRAFFIC_CONDITIONS_STALE_MS`. Closures are dropped from the graph; the router falls back to point exclusions.           |
| `traffic-live: span tracing failed, falling back to whole-way binding`    | The tracing pass itself failed. Closures still apply, whole-way instead of edge-exactly.                                                            |
| `traffic-live: conditions classification failed, writing no overrides`    | Turning conditions into edge overrides threw. Live speeds are still written, but this cycle applies no closures or caps; the next cycle retries.    |
| `traffic-live: span cache save failed`                                    | The trace cache could not be persisted. Harmless for correctness: the in-memory cache still serves the rest of this process, so only a restart loses the verdicts and re-traces them. |
| `traffic-live: skipped out-of-range edges (traffic.tar/waysToEdges mismatch)` | The way→edge map references edges the current `traffic.tar` does not have. The daily traffic-extract cron resolves this by rebuilding both.     |

A healthy instance shows `unanswered` at zero and `edgeExactSpans` dominating
`wholeWaySpans`. A rising `unanswered` points at the routing container, not at
the conditions feed; a `wholeWaySpans` that never falls usually means
`TRAFFIC_VALHALLA_URL` points somewhere other than the Valhalla holding this
deployment's traffic graph.

### Verifying edge closures end-to-end

Once the cycle reports closures, three requests confirm the graph really carries
them. First, check that conditions are arriving and that the writer credited
some of them:

```bash
curl -s "$OPENCONDITIONS_URL/segments/conditions.json" | jq '.conditions | length'
curl -s http://localhost:4000/traffic/conditions/applied | jq
```

Then pick one applied closure, take a pair of coordinates on the closed
carriageway either side of it, and route across it:

```bash
curl -s http://127.0.0.1:8002/route -d '{
  "locations":[{"lat":51.40,"lon":6.80},{"lat":51.45,"lon":6.95}],
  "costing":"auto","date_time":{"type":0}}' | jq '.trip.summary'

curl -s http://127.0.0.1:8002/route -d '{
  "locations":[{"lat":51.40,"lon":6.80},{"lat":51.45,"lon":6.95}],
  "costing":"auto","date_time":{"type":0},
  "costing_options":{"auto":{"ignore_closures":true}}}' | jq '.trip.summary'
```

The first must detour — a longer distance or time than the second, which ignores
closures and drives straight through. If the two summaries are identical, the
closure is not in the graph: check `closedEdges` in `traffic-live: conditions
applied` and whether the router is reading the same `traffic.tar` the writer
writes.

Finally, route between two points on the **same way but outside** the closed
span, for example from just past the closure to the next exit:

```bash
curl -s http://127.0.0.1:8002/route -d '{
  "locations":[{"lat":51.46,"lon":6.97},{"lat":51.48,"lon":7.02}],
  "costing":"auto","date_time":{"type":0}}' | jq '.trip.summary'
```

This one must succeed and stay on that way. That is the difference between an
edge-exact closure and the whole-way fallback: if it fails or detours, the span
was applied whole-way, and the `traffic-live: span tracing` counters will show
it as `negative`, `unanswered` or `skippedBudget` — unless the span was already
traced in an earlier cycle, in which case it only shows in `cacheHits`.

## Audit log

Every state-changing admin action is written to a durable audit trail. It's the
record of *who did what, to what, and when* — the accountability layer behind the
panel. Find it on `/admin/activity` under the **Audit Log** tab.

Each entry captures the **action** (a dotted name like `service.restart` or
`user.role.change`), the **actor** (the admin user, resolved to name and email),
the **target** (type and id — the integration, service, user, backup, and so on it
acted on), a **details** blob with action-specific context, the requester's **IP
address**, and a timestamp. Filter by action (grouped by subsystem —
Integrations, Services, Data, Backups, Settings, Users, and the rest), by target
type, or search by target id; destructive and auth-related actions are color-coded
so a ban or a credential deletion stands out.

The trail is written server-side by every admin endpoint as part of the action it
records, so the client can't suppress it. A few properties matter operationally:

- **CLI and loopback actions are recorded too.** A request that comes in over the
  loopback short-circuit (how the `openmapx` CLI calls admin endpoints) has no
  user row, so it's logged with a null actor and a `(loopback)` marker on the
  user-agent — the origin stays visible. See the
  [local admin escape hatch](./admin-panel.md) for that bypass.
- **A failed write never breaks the action.** If the audit insert fails, the error
  is logged and the underlying operation still completes — the audit log is
  accountability, not a gate.
- **Retention is bounded.** A daily prune deletes entries older than
  `AUDIT_LOG_RETENTION_DAYS` (default 90), so the table doesn't grow without limit
  on a long-lived instance. Raise or lower it via the env var.

Sitting alongside the audit log on the same page is the **Jobs** tab — the running
and recently-finished background jobs (installs, reloads, restarts, imports) with
their streamed logs. Job rows are pruned after `ADMIN_JOB_RETENTION_DAYS` (default
30). Between them, the audit log tells you the *intent* of every admin action and
the jobs view shows the *execution*.

Application job details are pushed to the browser over Server-Sent Events
(`GET /api/admin/jobs/<id>/events`). Every event carries a per-job cursor; when
the browser reconnects it resends the last cursor it saw and the API replays
what it missed from a bounded in-memory window, or sends a fresh snapshot when
that window has expired (for example after an API restart). If the stream keeps
failing the view falls back to polling. `GET /api/admin/jobs/stream-metrics`
reports active streams, reconnects, backfilled events, snapshot fallbacks,
slow-consumer disconnects, and job handler durations. Data-manager jobs are
written by a separate process and keep polling.

## Where to go next

- **[Admin panel](./admin-panel.md)** — the Overview dashboard and how access is
  gated.
- **[Services administration](./services-administration.md)** — container
  lifecycle and the per-service log drawer.
- **[Public transit](../features/public-transit.md)** — the transit pipeline the
  provider-health table belongs to.
- **[Users and access](./users-and-access.md)** — the roles and accounts the audit
  log attributes actions to.
- **[Backup and restore](./backup-and-restore.md)** — protecting the database the
  audit log and persisted logs live in.
- **[Configuration](../install/configuration.md)** — `OPENCONDITIONS_URL`,
  `TRAFFIC_LIVE_CRON`, `TRAFFIC_CONDITIONS_STALE_MS` and `TRAFFIC_VALHALLA_URL`,
  the knobs behind the live road-conditions cycle.
