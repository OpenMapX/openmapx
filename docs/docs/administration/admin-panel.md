---
title: Admin panel
description: Access the administration panel and choose the tools for your operator task.
sidebar_position: 1
---

# Admin panel

Open `/admin` after signing in with an administrator account. Use it to manage
users, integrations, extensions, services and privacy requests.

For a new deployment, [create and promote the first
administrator](./users-and-access.md#the-first-admin), then configure email and
review the instance settings.

## How access works

The browser checks the session before rendering administration pages. The API
enforces permissions separately:

| Role            | Access                                                                             |
| --------------- | ---------------------------------------------------------------------------------- |
| `user`          | Personal account features; no administration pages                                 |
| `privacy_admin` | Privacy casework at `/admin/privacy`; no general operations or deployment settings |
| `admin`         | Full administration, including privacy setup and role management                   |

A privacy administrator opening a general administration page is redirected to
privacy casework. See [Users and access](./users-and-access.md) for assigning
roles and [Data-subject requests](./data-subject-requests.md) for privacy work.

### The local admin escape hatch

Some CLI commands call the admin API without a browser session. This requires
both an actual loopback TCP peer (`127.0.0.1`, `::1`, or its IPv4-mapped form)
and the `x-openmapx-local-admin` header. `X-Forwarded-For` cannot grant access.

In production, configure `OPENMAPX_LOCAL_ADMIN_TOKEN` on the API and in the CLI
environment. Without a token, production rejects this shortcut. Development
accepts a present, empty header when no token is configured. Set
`OPENMAPX_DISABLE_LOCALHOST_AUTH=1` to disable it on a host where other tenants
can reach loopback. A remote API URL and token alone do not satisfy the peer
check. Privacy approvals and privacy-role changes require an attributable
signed-in administrator and reject the synthetic loopback identity.

The `openmapx users` recovery commands use Docker and PostgreSQL directly;
they do not use this HTTP shortcut.

## Self-hosted vs. hosted

Services and Maintenance appear when the deployment exposes Docker host control
through the operations agent. On a deployment without that control plane, use
the host's deployment tooling for container operations. Docker sockets and
registry credentials belong to the operations agent.

## The sections

### Overview

Start here when a feature fails. The dashboard shows health, user and integration
counts, failed jobs, missing credentials and, where available, service counts.
Open `/status` for the public health snapshot or **Activity** for execution logs.

### Users

Search accounts, edit names and roles, inspect or revoke sessions, ban users,
send password-reset email and impersonate an account for support. See
[Users and access](./users-and-access.md).

### Integrations

Enable features, edit non-secret configuration, set credentials, select
capability bindings and run health checks. See
[Integrations administration](./integrations-administration.md).

### Extensions

Use **Browse**, **Installed** and **Sources** to inspect and manage community
integrations, services and bundles. Review the exact service commit, effective
host ports and security rating before confirming. A verified catalog entry is
not a security audit. See [Community extensions](./community-extensions.md).

### Services _(self-hosted only)_

- **Catalog:** service selection, container state, configuration, credentials
  and lifecycle actions.
- **Compose preview:** generated Compose configuration and stack actions.
- **Data workflows:** source acquisition, transit publication, engine builds,
  Overture, search indexes and map-place publication. Forms and previews come
  from the API's operation catalog; destructive operations require confirmation.
- **Backups:** create, inspect, restore and delete retained snapshots.

See [Services administration](./services-administration.md) for procedures.

### Maintenance _(self-hosted only)_

Check the selected release against running image digests, download an update,
or run deep service probes. A release check does not download application images.
Updates offer a pre-update database backup, replace the operations agent when
needed, and checkpoint progress before replacing the API so the new process can
finish after migrations. Inspect the job outcome before retrying an interrupted
update. See [Upgrading](../install/upgrading.md).

You can start the update as soon as a check finishes. Checks have their own
once-per-30-seconds throttle, separate from the one shared by updates and
diagnostics. If the API rejects a request as too frequent, the page says so, keeps the update
confirmation open with your choices, and re-enables the action when the server's wait
is over. Nothing is retried automatically; press the button again when it is available.

### Transit

Inspect the Transitous catalog pin, feed/import state, provider health and
pipeline jobs. Pin changes require review. See
[MOTIS operations profiles](./motis-operations-profiles.md) and
[Public transit](../features/public-transit.md).

### Coverage & freshness

`/admin/coverage` reports eight domains: Addresses, POIs, Transit, EV, Parking,
Fuel, Cameras and Traffic. Publication, freshness, runtime, geography and rights
remain separate observations. **Unknown** means evidence is missing or cannot
be verified. See [Coverage & freshness](./coverage-freshness.md).

### Cache

Inspect and clear application-owned Redis/Valkey namespaces. **Clear all** is
limited to OpenMapX cache prefixes; it does not run `FLUSHDB` or `FLUSHALL` on a
possibly shared Redis instance. Clear only the affected namespace when possible.

### Activity

Follow queued jobs and inspect **Audit Log** or **Application Logs**. Application
job details stream live with reconnect and polling fallback; Data Manager jobs
use polling. A queued response is acceptance, so wait for a terminal job result.
See [Monitoring](./monitoring.md).

### Settings

Edit instance details, email, map settings, data-use policy and legal/controller
facts. Valid environment values take precedence over saved values, then defaults.
Environment overrides appear read-only; empty or invalid environment values do
not necessarily override a valid saved setting. JSON export excludes secrets.

The Authentication group exposes saved policy fields, but the current Better
Auth configuration does not consume its email-verification, session-duration,
two-factor or minimum-password-length values. Do not rely on those controls to
change enforcement. See [Authentication methods](./users-and-access.md#authentication-methods).

### Privacy setup

Full administrators use `/admin/privacy-setup` for controller details, email,
retention, source declarations and independent reviews. Privacy administrators
handle cases and inspect readiness through privacy casework. A release install
does not approve generation for the deployment. See
[Data-subject requests](./data-subject-requests.md).

## CLI coverage and deliberate exclusions

| Task                                                       | Admin location            |
| ---------------------------------------------------------- | ------------------------- |
| Service selection, status, lifecycle, builds and logs      | Services                  |
| Release check/update and deep probes                       | Maintenance               |
| Source downloads, transit sync, indexes, links and cleanup | Services → Data workflows |
| Extension install/update/removal                           | Extensions                |
| Account administration                                     | Users                     |
| Snapshot create/list/restore/delete                        | Services → Backups        |
| Application cache clearing                                 | Cache                     |
| Transitous pin inspection and approval                     | Transit                   |

Integration scaffolding, validation, building and packaging remain developer CLI
workflows. The panel excludes `compose down --volumes`, unrestricted Redis flushes
and individual low-level Overture phases. Use the documented orchestrated data
operations for routine administration.

## Where to go next

Choose [Services](./services-administration.md),
[Integrations](./integrations-administration.md),
[Extensions](./community-extensions.md), [Users](./users-and-access.md),
[Monitoring](./monitoring.md) or [Backup and restore](./backup-and-restore.md).
