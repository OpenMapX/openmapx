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

This page walks each of them and points at the code or env var behind the
behavior, so you can verify and tune rather than guess.

## Status dashboard

`/status` is the system-health snapshot — a quick "is everything up?"
check across the pieces the instance depends on, linked from the admin
**Overview** page. It calls the API's `/api/status`
endpoint, which reports `up`, `down`, or `not configured` with a measured
response time.

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

The page groups results by category (Infrastructure first), shows a running
count of operational / down / not-configured services, and displays each check's
target URL with passwords masked. A connection string is never shown with its
secret intact. Toggle **Auto-refresh** to refresh the view every 30 seconds while
the tab is visible, or hit **Refresh** on demand. Infrastructure checks run on
each refresh; integration results advance when the background scheduler
publishes its next snapshot, unless an administrator forces a sweep.

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
only from inside the Docker network. Restrict it with firewall or reverse-proxy
rules and do **not** expose `/api/internal/metrics` on the public reverse proxy.
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

The viewer is read-only — it's for triage, not configuration.

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
