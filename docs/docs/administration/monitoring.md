---
title: Monitoring & logs
description: Status dashboard, transit provider health, Prometheus metrics, service and application logs, and the admin audit trail.
sidebar_position: 6
---

# Monitoring, health & logs

Start with `/status` for reachability, then use **Admin → Activity** for failed
jobs and application logs. Use a service's log drawer for container-specific
failures. Full administrator access is required for the administration views.

| Symptom                               | Start here                        |
| ------------------------------------- | --------------------------------- |
| Dependency unavailable                | Status dashboard and service logs |
| Feature has no usable regional data   | Coverage & freshness              |
| Transit provider skipped or slow      | Transit provider health           |
| Queued operation did not finish       | Activity → Jobs                   |
| Unexpected administration change      | Activity → Audit Log              |
| Road conditions do not affect routing | Live road conditions below        |

## Status dashboard

`/status` shows the public system-health snapshot, linked from **Admin → Overview**. It calls `/api/status`, which reports `up`, `down`, or `not
configured` with a measured response time. This public representation never
varies by session cookie and omits target URLs, dependency errors, and refresh
error detail. Administrators can retrieve those fields from the separately
authenticated `/api/admin/status` endpoint; that response is always marked
`private, no-store`.

Two groups of checks run:

- **Infrastructure and external services**, probed directly: PostgreSQL (a
  `SELECT 1`), Redis (a `PING`), the GitHub API (used by the catalog and store),
  and SMTP (a TCP connect to the configured mail host). A dependency without its required configuration, such as `REDIS_URL` or `SMTP_HOST`, reports **Not configured**.
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

## Coverage and freshness evidence

Full administrators can open [Coverage & freshness](./coverage-freshness.md)
at `/admin/coverage`. This is a read-only operator report, not a health probe
or a legal/geographic completeness claim. It combines the data-manager's
bounded publication observations with passive integration and provider-health
observations. Opening or refreshing it does not acquire a provider probe lease,
run a job, change a policy, or mutate a cache.

The report deliberately keeps these questions separate: what is configured,
what was actually published, which region the publication is known to relate
to, when the active version was successfully checked, whether the freshness
deadline has passed, whether the runtime has a recent observation, and whether
the selected usage assessment has the required rights. A stale or expired
publication can remain visible as historical evidence, while an unknown state
means the required fact is unavailable or unverified. See the coverage guide
for the timestamp meanings, sidecar diagnostics, and existing corrective
workflows.

:::note[Status vs. service catalog]
The status dashboard reports whether the API can reach each dependency. It is not the Docker control plane. To start, stop, or
inspect a container's lifecycle state, use the service catalog under
`/admin/services`; see [Services administration](./services-administration.md).
:::

## Transit provider health

Open **Admin → Transit → Provider health**. The table shows success/failure
counts, recent failure rate, latency and cooldown state from shared Redis/Valkey
records. The shared circuit distinguishes `healthy`, `degraded` and `open`;
after cooldown, one process can acquire the half-open probe lease.

| Transition or limit   | Default                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Recent window         | Up to 100 counted calls                                                                    |
| Degraded              | Two consecutive counted failures, or at least four samples with failure rate at least 25%  |
| Open                  | Five consecutive counted failures, or at least ten samples with failure rate above 50%     |
| Cooldown sequence     | 5, 10, 20, 40, then 60 minutes on repeated opening                                         |
| Recovery              | A successful half-open call moves to degraded; three consecutive successes restore healthy |
| Half-open lease       | 30 seconds                                                                                 |
| EMA latency weighting | 0.2                                                                                        |
| Record expiry         | 30 days since last write                                                                   |

Timeouts, connection failures, upstream 5xx, authentication failures and invalid
payloads count toward opening. Valid empty responses, policy/input rejections,
quota denial and caller cancellation do not. Lifetime failure totals can
therefore differ from counted failures in the recent window.

If Redis is unavailable, the circuit returns a diagnostic and leaves provider
requests enabled. This differs from the quota-bound upstream runtime, which
refuses uncoordinated production refreshes without its store. Investigate store
failures before interpreting an empty health table as healthy providers.

After fixing a credential or endpoint, **Reset** clears that provider's window
and cooldown. Resetting does not repair the provider; verify a real request.

| Method | API path                                | Access                                          |
| ------ | --------------------------------------- | ----------------------------------------------- |
| GET    | `/api/data-manager/providers`           | Administrator or Data Manager service token     |
| GET    | `/api/data-manager/providers/:id`       | Administrator or Data Manager service token     |
| POST   | `/api/data-manager/providers/:id/reset` | Administrator; service token alone cannot reset |

Provider records use `provider:health:<providerId>` keys. Prefer the admin view
or read API to direct Redis editing, which can bypass the circuit's atomic
updates. See [Public transit](../features/public-transit.md) for feed/import jobs.

## Metrics

The transit and routing provider chains are instrumented with **OpenTelemetry**
and exported in **Prometheus** text format. Alongside each provider-health write,
the orchestrator bumps two transit instruments:

- `transit_provider_calls_total`: a counter, one increment per provider call.
- `transit_provider_call_duration_ms`: a histogram of per-call latency.

Both carry the same labels: `provider_id`, `method` (the orchestrator operation),
and `outcome`, a closed set of `ok`, `empty` (succeeded but returned nothing),
`error`, and `skipped` (the call was pre-empted by a health cooldown, a capability
mismatch, or a bounding-box miss). No label carries user input, so the series
cardinality is bounded by your provider catalogue.

Routing requests add these instruments:

- `routing_requests_total` and `routing_request_duration_ms`: request count and
  end-to-end latency, labelled by provider, mode, operation, outcome, live-traffic
  use, and closure avoidance.
- `routing_route_count` and `routing_alternate_count`: the number of routes the
  selected provider returned, and the number beyond the primary route.
- `routing_traffic_delay_seconds`: the signed live-duration minus baseline-duration
  delta. Negative values mean the live route was faster than its baseline.
- `routing_baseline_available_total`: whether the provider returned a usable
  baseline duration for comparison.

For a deployment-level smoke test, run `pnpm check-routing-canaries`. It checks
stable endpoint pairs and only asserts route availability, usable durations, and
the minimum route count; it deliberately does not require a live route to be
slower than its baseline or require every graph to produce the same number of
alternatives. Set `ROUTING_BASE_URL` to probe a non-public deployment.

Air-quality instruments are listed under [Air-quality metrics](./integrations-administration.md#air-quality-metrics). Configure your scraper for:

```
GET /api/internal/metrics
```

:::warning[Keep the metrics endpoint internal]
The route declares internal metadata but does not enforce an application
session or token. Its bounded labels exclude user input, but reveal provider
topology and request volumes. Restrict it to the monitoring network. The bundled Traefik configuration rejects
`/api/internal/*` from outside that network with HTTP 403 via the
`internal-deny` middleware. If you want external scraping, add a separate
authenticated route rather than removing this middleware.
:::

A Grafana dashboard template ships in the repo at
`infra/docker/dashboards/transit-providers.json`, with calls per second by provider
and outcome, latency percentiles, windowed failure rate, and a count of currently
cooled-down providers. Point a Grafana at a Prometheus that scrapes the endpoint
above and import the JSON.

## Logs

There are two log surfaces, and they answer different questions.

### Service container logs

For "what is this backend service doing right now," open a service's **Logs** tab
(or the **Logs** button) under `/admin/services/<id>`. It streams that container's
output live, tailing the most recent lines. It uses the same output as the equivalent
`services logs` CLI command, in the browser. This is the place to watch a build
finish or diagnose a container that won't come up. Full coverage is in
[Services administration](./services-administration.md).

### Application logs

Open **Activity → Application Logs** for the API gateway and integration log stream. It renders the API's structured (pino) log stream with a console-style view:
timestamp, level, source, and message, with any structured metadata appended.

Filter by **level** (a minimum level; `warn` includes warnings and higher levels), by **source** (the emitting subsystem), and by **time range**, plus a
free-text search. Auto-refresh polls every five seconds and follows the tail; pause
it to scroll back. Two things worth knowing about retention:

- Recent logs at every level live in an **in-memory ring buffer** (the most recent
  10,000 entries by default), so the viewer is fast but a restart clears them.
- `warn`, `error` and `fatal` entries are also submitted to `app_logs` on a
  best-effort basis. Database unavailability can lose persisted entries; logs
  are not a guaranteed audit or delivery channel.

Persisted application logs are pruned daily using
`LEGAL_SERVER_LOG_RETENTION_DAYS` (30 days by default). Review the value against
the deployment's published policy.

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

The viewer is read-only.

## Live road conditions in the routing graph

The Data Manager live-traffic cycle reads OpenConditions, resolves road events
to Valhalla edges and publishes bounded application evidence. Its default
schedule is `TRAFFIC_LIVE_CRON=*/2 * * * *`.

Road-event overrides default to `TRAFFIC_ROAD_CONDITIONS_MODE=shadow`: the cycle
evaluates candidates without writing their closures or speed caps. Enabling
`active` changes routing behavior. Verify source rights, policy, graph identity,
capacity and failure recovery in an isolated deployment before enabling it.
Live-speed writes have their own source evidence and lease handling.

### What the writer puts into the graph

In active mode, eligible car closures produce closed edge records and mandatory
speed limits cap applicable live speeds. A closure takes precedence; the lower
of two caps wins. The writer requires current routing evidence, allowed source
policy, applicable vehicle/effect semantics and a complete span mapping. Crowd
reports also need routing eligibility. Ambiguous bindings and unresolved partial
events remain display/fallback evidence.

Each write has a bounded lease, graph generation and engine-boot identity.
Road-event validity is also bounded by source, policy and effect deadlines.
The cycle renews leases when needed; expired snapshots expose no applied IDs or
receipts. A recent timestamp alone does not prove that a returned route consumed
the write.

### How a closure is narrowed to the edges it really covers

The cycle traces each bound span through the configured Valhalla
`/trace_attributes` endpoint and cross-checks returned edges against the current
way-to-edge map and direction.

- A resolved span uses its verified edge subset.
- Only a proven full-way span (`startFraction: 0`, `endFraction: 1`) can use the
  complete directed-way map without a trace.
- An unresolved partial span keeps the entire observation unapplied. It does
  not fall back to closing the whole way.

The trace cache lives at `traffic/span-edges-cache.json`. Its keys bind graph and
source revisions. Negative traces are cached; transport failures and work skipped
by the tracing dispatch budget are retried on the next cycle. The default
30-second budget bounds new dispatch, while an already dispatched request keeps
its own timeout. Lifted spans are pruned when current feed evidence is available.

### The applied set

Read `GET /traffic/conditions/applied` on Data Manager from the trusted service
network, using its configured `Authorization: Bearer` service token. The running Data Manager requires authentication for this route. Production
requires `DATA_MANAGER_AUTH_TOKEN`; development generates an ephemeral token
when none is configured. Do not publish it as an anonymous monitoring endpoint.

The response includes mode, write ID, engine boot, graph generation, policy
revision, expiry, per-effect receipts, `writtenAt` and applied observation IDs.
Before the first successful cycle, `writtenAt` is null. Without the traffic
subsystem the endpoint returns 501. Expired leases return empty receipts/IDs.

The routing integration reads this snapshot with a two-second timeout, no
reusable cache and a bounded response size. It compares each route's Valhalla
traffic proof with the write/engine/graph IDs, current policy and complete
per-effect receipts. Source revision, intended spans, licence and attribution
must match. Missing or expired proof retains the fallback/limited assessment;
an ID appearing in a writer response alone is insufficient.

The [Coverage & freshness](./coverage-freshness.md) sidecar remains historical
publication evidence and does not carry the route's serving-process proof.
A successful graph-write row cannot by itself qualify traffic-aware routing.

### Log lines to watch

Open Data Manager's **Logs** drawer or run
`pnpm openmapx services logs data-manager`.

| Message or field                                                     | Check                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `traffic-live: conditions applied`                                   | `mode`, candidate/written edges, unresolved edges and applied-condition counts; shadow candidates do not prove active application |
| `traffic-live: span tracing`                                         | `unanswered`, `negative`, `skippedBudget`, cache hits and exact/full-way counts                                                   |
| `graph generations unavailable or changed; withholding live effects` | Engine identity and graph/map maintenance state                                                                                   |
| `span tracing failed; partial spans remain unapplied`                | Valhalla reachability and trace responses; partial spans stay unapplied                                                           |
| `bound ways missing from way→edge map, scheduling refresh`           | Graph/feed vintage; refresh is limited to at most hourly                                                                          |
| `conditions classification failed, writing no overrides`             | Classification failure; do not infer closures from live-speed success                                                             |
| `span cache save failed`                                             | Persistence permissions; a restart will lose unsaved cache state                                                                  |
| `skipped out-of-range edges (traffic.tar/waysToEdges mismatch)`      | Rebuild the graph-associated traffic/map artifacts through the normal maintenance workflow                                        |

For upstream failures, inspect the configured stale window
`TRAFFIC_CONDITIONS_STALE_MS` and the source/policy expiry. Old conditions are
not permitted to extend expired routing evidence. Repeated missing ways,
negative traces or mismatched generations require investigation even if other
cycle counters look healthy.

### Verifying edge closures end-to-end

Use an isolated, representative dataset and synthetic route coordinates:

1. Confirm fresh source evidence, authoritative policy and a known closure
   applicable to ordinary cars at the test time.
2. Check the cycle's mode. Shadow results cannot prove a written closure. For an
   approved active-mode test, inspect complete, unexpired receipts and the
   matching engine/graph identity.
3. Route across the closure and compare with a controlled request that uses
   `ignore_closures`. Inspect route geometry and traffic proof as well as summary
   distance/time. Equal summaries alone do not establish the cause.
4. Route on the same way outside a partial closed span. Confirm that unrelated
   edges remain usable; unresolved partial spans must not produce whole-way
   closure.
5. Exercise expiry, feed failure and engine restart. Confirm that expired or
   mismatched proof cannot claim current application and that fallback behavior
   remains available.

A writer log, a stored receipt or a mocked test is narrower evidence than this
runtime drill. Record the source/graph revisions, test time and actual observed
route behavior. Do not claim production acceptance from a source inspection.

## Audit log

Administration handlers record supported mutations in `admin_audit_log`. Open **Activity → Audit Log** to inspect actor, target, action and time. Audit writes are generally best effort, so the trail is not a guarantee that every host or database action was recorded.

Each entry captures the **action** (a dotted name like `service.restart` or
`user.role.change`), the **actor** (the admin user, resolved to name and email),
the **target** (type and ID), a **details** blob with action-specific context, the requester's **IP
address**, and a timestamp. Filter by action (grouped by subsystem), by target
type, or search by target id; destructive and auth-related actions are color-coded
so a ban or a credential deletion stands out.

The server writes the trail independently of the client. Its operational limits are:

- **CLI and loopback actions are recorded too.** A request that comes in over the
  loopback short-circuit (how the `openmapx` CLI calls admin endpoints) has no
  user row, so it's logged with a null actor and a `(loopback)` marker on the
  user-agent. See the
  [local admin escape hatch](./admin-panel.md) for that bypass.
- **A failed write never breaks the action.** If the audit insert fails, the error
  is logged and the underlying operation can still complete.
- **Retention is bounded.** A daily prune deletes entries older than
  `AUDIT_LOG_RETENTION_DAYS` (default 90), so the table doesn't grow without limit
  on a long-lived instance. Raise or lower it via the env var.

The **Jobs** tab lists running and recently finished background operations with their logs. Job rows are pruned after `ADMIN_JOB_RETENTION_DAYS` (default
30). Between them, the audit log tells you the _intent_ of every admin action and
the jobs view shows the _execution_.

Application job details are pushed to the browser over Server-Sent Events
(`GET /api/admin/jobs/<id>/events`). Every event carries a per-job cursor; when
the browser reconnects it resends the last cursor it saw and the API replays
what it missed from a bounded in-memory window, or sends a fresh snapshot when
that window has expired (for example after an API restart). If the stream keeps
failing the view falls back to polling. `GET /api/admin/jobs/stream-metrics`
reports active streams, reconnects, backfilled events, snapshot fallbacks,
slow-consumer disconnects, and job handler durations. `maxPublishLagMs` is the
largest elapsed time from an event's publication to its server-side stream write,
including reconnect backfill; it does not measure network or browser delivery.
`handlerDurations` provides count, total milliseconds and maximum duration.
`handlerDurationMs` provides cumulative histogram counts with inclusive upper
bounds of 100, 1,000, 10,000 and 60,000 milliseconds; the final `null` bound includes
all durations, including overflow. Metrics describe the current API process and
reset on restart. Data-manager jobs are written by a separate process and keep
polling.

## Where to go next

Use [Services](./services-administration.md) for lifecycle actions,
[Users](./users-and-access.md) for access controls and
[Backup and restore](./backup-and-restore.md) for recovery. See
[Configuration](../install/configuration.md) for traffic and retention variables.
