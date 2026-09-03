---
title: Admin panel
description: A tour of /admin — how access is gated and what each section of the operations surface is for.
sidebar_position: 1
---

# Admin panel

The admin panel at `/admin` is the operations surface for everything that
doesn't belong on the user-facing map: managing services and integrations,
installing community extensions, looking after users, watching system health,
and tuning instance settings. It runs inside the same web app as the map, but
behind a role check — ordinary users never see it.

This page is a map of the panel. Each section below is a one- or two-line tour;
where a subsystem has its own page, that's where the detail lives.

## How access works

Two layers gate the panel, and they line up.

- **In the browser**, the `/admin` route checks your session before it renders.
  If you're not signed in, or your account doesn't have the `admin` role, you're
  redirected back to the map. Roles are managed in [Users and
  access](./users-and-access.md) — the first account on a fresh instance is
  promoted to admin during setup.
- **On the API**, every admin endpoint runs behind a `requireAdmin` check that
  re-verifies the session and role on the server, so a forged client can't reach
  the data the panel shows. Each state-changing action is also written to the
  audit log with the actor and target (see [Monitoring](./monitoring.md)).

### The local admin escape hatch

There's one deliberate bypass for tooling. A request that arrives over the
**loopback interface** (`127.0.0.1` / `::1`) from a process on the same host is
treated as admin without a session — this is how the `openmapx` CLI calls admin
endpoints without first acquiring login cookies. The trust assumption is that
anyone with a shell on the API host already has the API's own level of access.

The short-circuit reads the real TCP peer address (not a spoofable
`X-Forwarded-For` header) and, to block localhost CSRF, requires a custom
`x-openmapx-local-admin` header that browsers can't set on a cross-origin form.
In production you set `OPENMAPX_LOCAL_ADMIN_TOKEN` so the header's value must
match. On a multi-tenant host where loopback isn't a trust boundary, disable the
bypass entirely with `OPENMAPX_DISABLE_LOCALHOST_AUTH=1`.

## Self-hosted vs. hosted

The panel adapts to how the instance is deployed. When OpenMapX is running its
own Docker stack, the **Services** section (and its sub-pages) appears, because
those tools drive `docker compose` on the host. On a managed deployment with no
Docker control plane, that section is hidden — there are no containers for the
panel to start or stop. Everything else in the sidebar is present either way.

## The sections

The sidebar lists each area of the panel. Here's what each one is for.

### Overview

The landing dashboard. It rolls up system health, user counts, integration
status (enabled, unhealthy, missing credentials), and — on a self-hosted
instance — running service counts, alongside an **attention** list of things
that need a look: failing health checks, failed jobs, unconfigured credentials.
It's the page to open first when something feels off, and it links out to the
full `/status` health snapshot (see [Monitoring](./monitoring.md)).

### Users

Better Auth user management — list and search accounts, view a single user's
sessions, set roles, ban, and impersonate. This is where admin access itself is
granted. See [Users and access](./users-and-access.md).

### Integrations

The list of every loaded integration — the app-level features (geocoding,
routing, transit, weather, and the rest) — with their domains, enabled state,
health, and whether their credentials and required services are satisfied. Click
into one to edit its config, set secrets, and bind it to a backend service; a
bulk page configures every integration at once. See [Integrations
administration](./integrations-administration.md).

### Extensions

The unified extension store: browse, install, update, and remove third-party
extensions — integrations, services, and bundles of both — across **Browse**,
**Installed**, and **Sources** tabs. Each entry shows its trust tier
(built-in / verified / community) and, for services, a security rating before you
confirm. See [Community extensions](./community-extensions.md).

### Services *(self-hosted only)*

The backend control plane, with sub-pages for the day-to-day work:

- **Catalog** — every installed service (built-in or extension-installed), its
  capabilities and container state, with start/stop/restart.
- **Compose preview** — the generated `docker-compose` file, so you can see what
  the renderer will do before bringing the stack up.
- **Data workflows** — the inventory of downloaded data (OSM extracts, GTFS
  feeds, glyph fonts), GTFS import controls, and Overture Places release and
  durable OSM↔GERS link operations.
- **Backups** — the on-disk snapshot manager. See [Backup and
  restore](./backup-and-restore.md).

The full picture of services and the `openmapx` CLI that backs these pages is in
[Services administration](./services-administration.md) and [Managing
services](../install/managing-services.md).

### Maintenance *(self-hosted only)*

Stages current core images without restarting containers, compares them with
the running application, and updates Data Manager, Web, API, Ops Agent, and
Transitous Runner in a controlled order. Updates create a database backup by default
and checkpoint the operation before replacing the API, so the new API process can
finalize the job after its migrations succeed. The pre-update backup is recommended
but optional in the confirmation dialog. The same page runs the CLI-equivalent deep service probes.

### Transit

The public-transit data pipeline: the Transitous feed snapshot, audited catalog
pin changes, per-feed import state and expiry, provider health, and the recent
and in-flight pipeline jobs that keep the transit engine's data fresh.

### POI ingest

The operator surface for the points-of-interest ingest crons that feed data
sources like EV charging and parking. It shows per-source schedule, last-run and
row counts, in-flight jobs, recent failures, and a manual **Sync** action for
triaging a stale or broken source.

### Cache

The Redis/Valkey cache inspector — list the cache namespaces (geocoding
results, provider responses, and the rest) with their key counts, and clear one
namespace or the whole cache. Handy after switching a provider or credential so
stale responses don't linger.

### Activity

The audit and jobs view: the running and recently finished background jobs
(installs, reloads, restarts, imports) with their logs, and the audit log of
every state-changing admin action — who did what, to what, and when. See
[Monitoring](./monitoring.md).

### Settings

Instance-wide configuration, grouped into **General** (instance name and URL,
default locale, default map center), **Authentication** (email verification,
session duration, two-factor, password policy), **Email** (the From address and
the EmailLabs / Lettermint / SMTP provider that sends it, with a test-send
button), **Map** (the base-style provider and its key), and **Data-Use Policy**
(toggles that include or exclude non-commercial-only and undocumented-terms data
sources).

Each setting resolves through the same three-layer cascade the rest of OpenMapX
uses — an environment variable wins over a value saved here, which wins over the
built-in default — and the form shows which source is in effect for every field.
A field pinned by an env var is read-only, because the environment always wins.
Settings can be exported and re-imported as JSON (secrets excluded). For how the
cascade and `infra/docker/.env` fit together, see
[Configuration](../install/configuration.md).

## CLI coverage and deliberate exclusions

The panel covers the routine operator workflows while keeping development-only
and unusually destructive primitives in the CLI.

| CLI area | Admin equivalent |
| --- | --- |
| Service discovery, selection, lifecycle, builds, status, and logs | **Services** catalog and detail pages |
| Core image pull/update and deep checks | **Maintenance** |
| OSM, GTFS, styles, builds, links, cleanup, and Overture full sync/resume/status | **Services → Data workflows** |
| Extension browse/install/update/remove | **Extensions** |
| User roles and account administration | **Users** |
| Backup create/list/restore/delete | **Services → Backups** |
| Cache inspection and safe namespace clearing | **Cache** |
| POI ingest state/list/detail/sync/live-only sync | **POI ingest** |
| Transitous lock inspection and audited pin bump | **Transit** |

Integration scaffolding, validation, building, and packaging remain CLI-only
because they are developer workflows, not production administration. Raw
`compose down --volumes`, unrestricted Redis `FLUSHDB`, and individual low-level
Overture pull/ingest/extract phases are also deliberately not exposed; the panel
offers the safer orchestrated operation instead.

## Where to go next

- **[Services administration](./services-administration.md)** — the backend
  control plane in depth.
- **[Integrations administration](./integrations-administration.md)** —
  configuring features, secrets, and capability bindings.
- **[Community extensions](./community-extensions.md)** — installing from the
  unified Extensions store.
- **[Users and access](./users-and-access.md)** — roles, sessions, and
  moderation.
- **[Monitoring](./monitoring.md)** — health, jobs, and the audit log.
- **[Backup and restore](./backup-and-restore.md)** — snapshots and recovery.
