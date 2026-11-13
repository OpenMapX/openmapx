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

| Role    | Access                                                                      |
| ------- | --------------------------------------------------------------------------- |
| `user`  | Personal account features; no administration pages                          |
| `admin` | Full administration, including privacy casework, privacy setup and accounts |

See [Users and access](./users-and-access.md) for assigning roles and
[Data-subject requests](./data-subject-requests.md) for privacy work.

### The local admin escape hatch

Some CLI commands call the admin API without a browser session. This requires
both an actual loopback TCP peer (`127.0.0.1`, `::1`, or its IPv4-mapped form)
and the `x-openmapx-local-admin` header. `X-Forwarded-For` cannot grant access.

In production, configure `OPENMAPX_LOCAL_ADMIN_TOKEN` on the API and in the CLI
environment. Without a token, production rejects this shortcut. Development
accepts a present, empty header when no token is configured. Set
`OPENMAPX_DISABLE_LOCALHOST_AUTH=1` to disable it on a host where other tenants
can reach loopback. A remote API URL and token alone do not satisfy the peer
check. Privacy casework requires an attributable signed-in administrator and
rejects the synthetic loopback identity.

The `openmapx users` recovery commands use Docker and PostgreSQL directly;
they do not use this HTTP shortcut.

## Self-hosted vs. hosted

Host-operation topics in System appear for self-hosted or unknown deployments.
Explicitly hosted deployments retain Cache and Configuration transfer, while direct
entry into host topics shows an availability explanation. On a deployment without that control plane, use
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

### System

System groups operational topics without mixing them into application Settings:

- **Services:** searchable inventory, configuration, credentials, logs and service actions. Bulk controls appear after selecting targets; presets change action targets only. Build All reviews a captured service list.
- **Deployment:** persistent service roots and their required dependencies, domain, ACME contact and default region. Compose preview and stack actions are in a disclosure.
- **Updates:** release selector, checked image updates and update progress.
- **Backups:** create, inspect, restore and delete snapshots, with backup retention in the same topic.
- **Diagnostics:** readiness evidence and deep service probes.
- **Cache:** inspect and clear application caches.
- **Configuration transfer:** configuration migration export and import, and protected credential transfer.

Services, Deployment, Updates, Backups and Diagnostics require self-hosted control. Cache and Configuration transfer remain available to hosted administrators.

Release checks do not download application images. Updates can create a pre-update database backup, replace the operations agent and checkpoint progress before replacing the API. Updates and diagnostics share admission state: the job table admits only one queued or running release check, update or diagnostics job, so two requests sent at the same moment create one job and the other receives a conflict naming it. Inspect the original job before retrying an interrupted or unknown outcome. Check and update throttles remain distinct. See [Upgrading](../install/upgrading.md).

Platform previews preserve the fresh configuration owned by other topics. Applying an expired or conflicting preview requires a new review. Domain changes retain DNS/TLS, alternate-login, OAuth and passkey recovery checks. See [Services administration](./services-administration.md).

### Data

`/admin/data` is a directory. It reads the aggregate inventory without polling every data family. Open a workspace to inspect its authoritative evidence:

- **OSM:** extract age, paginated disk/build inventory, OSM and font downloads, and Overpass conversion.
- **Overture:** release sync, durable linking and advanced recovery phases.
- **Search & places:** search index, ambient data and notable-place publication.
- **Transit:** Sources, Catalog, Credentials, Pipeline and Mobility tabs. Sources shows desired acquisition separately from active publication; Catalog retains paired pin review and validation. Credentials retains actor-scoped reauthentication without putting secrets in navigation state.
- **Coverage & freshness:** geography, publication, freshness and rights evidence.
- **Prepared transfers:** existing staged artifact import/export review.
- **Advanced operations:** full update, hardlink sync and destructive cleanup.

Launchers open one existing schema-driven operation form at a time. The API still owns fields, defaults, validation and preview. Destructive operations retain explicit confirmation. Hidden workspaces do not run their domain status queries. See [MOTIS operations profiles](./motis-operations-profiles.md) and [Public transit](../features/public-transit.md).

### Coverage & freshness

`/admin/data/coverage` reports eight domains: Addresses, POIs, Transit, EV, Parking,
Fuel, Cameras and Traffic. Publication, freshness, runtime, geography and rights
remain separate observations. **Unknown** means evidence is missing or cannot
be verified. See [Coverage & freshness](./coverage-freshness.md).

### Cache (System)

The Redis/Valkey cache inspector — list the cache namespaces (geocoding
results, provider responses, and the rest) with their key counts, and clear one
namespace or the whole application cache. A scoped Redis glob must begin literally
with `int:` or `cache:` and contain at most 256 characters. **Preview pattern**
counts without deleting or changing invalidation state; counts are estimates under
concurrent writes and SCAN duplication. **Clear previewed pattern** requires a
confirmation of the captured target. Session/job/foreign prefixes and unrestricted
`*` are rejected. **Clear all** also stays within OpenMapX cache prefixes. Web clears never run
`FLUSHDB` or `FLUSHALL` on a shared Redis instance.

Clears consume SCAN pages and delete bounded batches, preserving the shared
invalidation fence against concurrent cache fills.

Handy after switching a provider or credential so
stale responses don't linger.

### Activity

Follow queued jobs and inspect **Audit Log** or **Application Logs**. Application
job details stream live with reconnect and polling fallback; Data Manager jobs
use polling. A queued response is acceptance, so wait for a terminal job result.
See [Monitoring](./monitoring.md).

### Settings

Edit instance details, email, map settings and data-use policy by topic. Legal and
controller facts belong to Privacy setup. Valid environment values take precedence over saved values, then defaults.
Environment overrides appear read-only; empty or invalid environment values do
not necessarily override a valid saved setting. JSON export excludes secrets.

Authentication edits the effective four-field policy as one reviewed change.
Existing sessions keep their original expiry; disabling new 2FA enrollment keeps
existing factors and sign-in challenges. Environment-owned email verification is
read-only. See [Authentication methods](./users-and-access.md#authentication-methods).

### Privacy setup

Full administrators use `/admin/privacy-setup` for controller details, email
delivery, retention and source declarations. Cases are handled in privacy
casework. See [Data-subject requests](./data-subject-requests.md).

## CLI coverage and deliberate exclusions

| Task                                                       | Admin location                 |
| ---------------------------------------------------------- | ------------------------------ |
| Service selection, status, lifecycle, builds and logs      | System → Services / Deployment |
| Release check/update and deep probes                       | System → Updates / Diagnostics |
| Source downloads, transit sync, indexes, links and cleanup | Data workspaces                |
| Extension install/update/removal                           | Extensions                     |
| Account administration                                     | Users                          |
| Snapshot create/list/restore/delete                        | System → Backups               |
| Application cache clearing                                 | System → Cache                 |
| Transitous pin inspection and approval                     | Data → Transit → Catalog       |

Integration scaffolding, validation, building and packaging remain developer CLI
workflows. The panel excludes `compose down --volumes`, unrestricted Redis flushes
and unrestricted destructive host commands. Overture advanced recovery retains its specialized pull, ingest and extraction controls; use orchestrated data operations for routine administration.

## Where to go next

Choose [Services](./services-administration.md),
[Integrations](./integrations-administration.md),
[Extensions](./community-extensions.md), [Users](./users-and-access.md),
[Monitoring](./monitoring.md) or [Backup and restore](./backup-and-restore.md).

## Administration navigation

The primary navigation has nine workspaces: Overview, Integrations, Extensions,
Data, Users, Privacy, Activity, Settings and System. Settings and System provide
local topic navigation; on small screens, choose a topic from the selector.
Search administration (Cmd/Ctrl+K) finds pages, setting labels, service names and
data tasks. It navigates to a control without running the task or changing a value.

Settings owns General, Authentication, Email, Map and Data use. Operator details,
legal facts and privacy retention belong to Privacy setup. The email readiness
step links to Settings → Email. Configuration migration export and import and
protected credential transfer belong to System → Configuration transfer.

System groups Services, Deployment, Updates, Backups, Diagnostics, Cache and
Configuration transfer. Explicitly hosted deployments show Cache and
Configuration transfer; host operations and the unsupported Platform editor are
hidden. When deployment status is unknown, troubleshooting topics remain visible.

Existing Services, Transit, Coverage and Cache URLs redirect to their canonical
workspace, retaining supported public navigation state. Ordinary unsaved drafts
survive topic changes. The draft count in the top bar can discard all ordinary
drafts after confirmation, including drafts for a removed service or integration.
Draft values remain in this browser document's memory only.

## Privacy case navigation

Casework uses `?case=<id>&section=<section>` for direct, authorized detail access independently of queue membership. Identity, Tasks, Decisions, Attachments, Generation & delivery and Events are addressable disclosures. Ordinary case form inputs survive section toggles; private delivery controls dispose when closed. Available work and denial reasons come from the server capabilities, and version conflicts require refresh.

Changing cases, including browser Back, clears the previous pending delivery. A reauthentication return without a case restores its matching pending case. Configuration stays in Privacy setup. On narrow screens a case selector replaces the long side queue.
