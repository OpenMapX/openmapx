---
title: Self-hosting location history (Dawarich)
description: Provision managed Dawarich or connect an external instance, then view a personal day timeline in OpenMapX.
sidebar_position: 8
---

# Self-hosting location history with Dawarich

OpenMapX can display a personal timeline from [Dawarich](https://dawarich.app/).
Tracking apps and imports send history directly to Dawarich. To view it in
OpenMapX, each user connects their own Dawarich API key.

Complete [Getting started](../install/getting-started.md) before adding the
managed bundle. Existing Dawarich users can skip deployment and follow
[Connecting Dawarich to OpenMapX](#connecting-dawarich-to-openmapx).

## How Dawarich fits into OpenMapX

Dawarich stores location points, imports, visits, and tracks in its own database
and file volumes. The OpenMapX timeline viewer reads a selected day through the
API server; it does not run a background tracker or send history to search
providers. It stores the encrypted connection credential and operational
metadata, while fetched day geometry stays out of the ordinary OpenMapX database
and shared cache.

Managed privacy exports and operator backups are separate workflows that can
contain personal data. Protect them independently; a read-only timeline viewer
does not make the whole deployment free of stored location history.

## Managed bundle vs. external instance

|                    | Managed bundle                                          | External instance                       |
| ------------------ | ------------------------------------------------------- | --------------------------------------- |
| Deployment         | Four services in this Compose stack                     | Existing separate Dawarich installation |
| Public origin      | `https://timeline.<DOMAIN>` by default                  | User-supplied supported HTTPS origin    |
| Browser login      | OpenMapX OIDC or retained local recovery login          | Managed by that instance                |
| Timeline API       | Personal Dawarich API key                               | Personal Dawarich API key               |
| Backup and updates | OpenMapX service workflow plus protected recovery state | External operator's responsibility      |

OIDC authenticates a browser session. It does not replace the personal API key
needed by the OpenMapX viewer, and signing out of OpenMapX does not sign out of
the separate Dawarich browser session.

## The managed Dawarich stack

| Service            | Role                                | Default memory ceiling |
| ------------------ | ----------------------------------- | ---------------------- |
| `dawarich-app`     | Dawarich 1.19.0 web app             | 4 GiB                  |
| `dawarich-sidekiq` | Background worker, concurrency 3    | 2 GiB                  |
| `dawarich-postgis` | Dedicated PostgreSQL 18/PostGIS 3.6 | 2 GiB                  |
| `dawarich-redis`   | Dedicated Redis 8.10 queue/cache    | 512 MiB                |

The app and worker use the same digest-pinned Dawarich image. Their database,
Redis, credentials, cookies, and volumes are separate from the OpenMapX platform
ones. Selecting `dawarich-app` selects the complete bundle; only the application
gets a public route. Database, Redis, and worker remain private.

### Resource requirements

Budget the 8.5 GiB combined container ceilings **in addition** to OpenMapX and
host overhead. These are limits, not measured idle use. Imports, reverse
geocoding, point density, attachments, retained history, and backups determine
actual capacity. Test a representative synthetic import before onboarding users.

The default `STORE_GEODATA=true` can send coordinates to Dawarich's configured
reverse geocoder. Review that provider and its terms before recording history.

:::caution[Verify dedicated database persistence]
Before recording real history, check that the running database's `PGDATA` is
inside the intended persistent Docker volume and survives container recreation.
The Dawarich manifest currently mounts `/var/lib/postgresql/data`; the platform's
PostgreSQL 18 manifest mounts `/var/lib/postgresql`. Resolve any image/path
mismatch on a disposable setup before relying on retained history. A successful
logical backup alone does not prove live persistence.
:::

## Deploying managed Dawarich

### Step 1: Configure DNS

Create DNS for `timeline.<DOMAIN>` pointing to the host. With bundled Traefik,
TCP 80/443 must reach it for certificate issuance and HTTPS. If using an external
proxy, apply the [external-proxy requirements](../install/managing-services.md#behind-an-existing-reverse-proxy)
and route the Dawarich hostname without a path prefix.

### Step 2: Start the services

Provision the bundle before attempting to start it:

1. Open **Admin → Services** and the **Dawarich Timeline** detail.
2. In **Managed Dawarich setup**, enter a public hostname if the default is not
   suitable, then choose **Provision/reconcile**.
3. Resolve any reported conflict before continuing. Provisioning creates or
   reconciles the persisted Better Auth client, shared vault secrets, and
   service configuration. It does not start containers.
4. Select `dawarich-app` in the service selection if not already selected.
5. Use the admin **Apply changes** or **Save & Apply** controls for both
   **Dawarich Timeline** and **Dawarich Sidekiq**. Check that the setup's apply
   notice clears only after both consumers use the current generation.

The first apply must be through the admin workflow: it reads newly provisioned
database and vault values. A fresh CLI render before that apply cannot read
them. After the first successful admin apply, CLI renders preserve the applied
settings and file-backed secrets.

The shared database password, Rails key, and OIDC secret are managed through the
provisioner. The generic Credentials tab deliberately blocks independent Set,
Rotate, and Remove actions. Do not create guessed secret files or set plaintext
fallbacks. A conflict between database/Rails copies needs coordinated maintenance;
see [Troubleshooting and recovery](#troubleshooting-and-recovery).

### Step 3: Verify single sign-on (OIDC)

Open `https://timeline.<your-domain>` and choose **Sign in with OpenMapX**. The
expected configuration is:

```text
Issuer:       https://<DOMAIN>/api/auth
Redirect URI: https://timeline.<DOMAIN>/users/auth/openid_connect/callback
Flow:         Authorization Code with S256 PKCE
Scopes:       openid profile email
```

A custom hostname changes the callback accordingly. The provisioner maintains
that exact relationship. Test signed-out sign-in and an existing OpenMapX
session. A Dawarich account with the same email can require explicit account
linking; do not bypass that challenge.

Keep a verified local Dawarich administrator login until OIDC and linking have
been tested. On shared devices, sign out of both applications.

## Connecting Dawarich to OpenMapX

### Step 1: Copy your Dawarich API key

Sign in to Dawarich and open **Account settings** at `/users/edit`. Copy your
personal API key. Use a key belonging to the intended user, not an operator's
shared key.

### Step 2: Link the key in OpenMapX

1. Open OpenMapX account settings and **Personal timeline**.
2. Choose the managed instance, or enter the external instance's HTTPS origin.
3. Paste your key and choose **Connect**.

OpenMapX validates `/api/v1/users/me` and `/api/v1/settings`, then stores the key
encrypted with `OPENMAPX_SECRETS_KEY`. The connection response does not return the
raw key. External origins are checked for unsafe targets; HTTP, embedded
credentials, and unsupported origins are rejected. Operators can allow specific
private DNS hostnames through `OPENMAPX_DAWARICH_PRIVATE_HOSTS`; this is a narrow
network exception and does not remove the other origin checks.

The managed connection uses `http://dawarich-app:3000` internally; browser links
use the public HTTPS origin. An unavailable or unprovisioned bundle cannot be
selected as a working managed source.

## Recording your location history

Record and import directly in Dawarich. OpenMapX does not perform these writes.

### Continuous mobile tracking

#### 1. Official Dawarich mobile app (iOS & Android)

Install a supported client from the
[Dawarich tracking guide](https://dawarich.app/docs/getting-started/track-your-location/), enter
your instance URL and personal key, and configure background permissions and
recording frequency. Confirm a small test appears in Dawarich before leaving
tracking enabled.

#### 2. OwnTracks (iOS & Android)

Select HTTP mode and use your Dawarich receiver URL:

```text
https://timeline.<your-domain>/api/v1/owntracks/points?api_key=<YOUR_KEY>
```

Configure the tracker ID and recording mode for your device, then confirm a test
upload. Follow [Dawarich's client instructions](https://dawarich.app/docs/getting-started/track-your-location/)
for supported formats.

#### 3. Overland (iOS)

Configure its receiver endpoint:

```text
https://timeline.<your-domain>/api/v1/overland/batches?api_key=<YOUR_KEY>
```

These URLs contain credentials. Keep them out of screenshots, support reports,
proxy query logs, and shared configuration.

### Importing past history (Google Takeout, GPX, Strava)

Open Dawarich's **Imports** and choose the importer matching your actual export
format. Google exports vary between account Takeout and device-based Timeline
exports; do not assume every account still supplies `Records.json`. Keep the
original archive and test a small supported file first. Follow
[Dawarich's import documentation](https://dawarich.app/docs/getting-started/import-existing-data/)
for current supported formats and integrations.

Monitor `dawarich-sidekiq` logs and the import's progress. Large imports can need
substantial temporary space and processing time. The watched-import directory
`/var/app/tmp/imports/watched` is a **container path** in the
`openmapx-dawarich-watched` named volume, not a host directory. Use the upstream
watched-import layout and resolve the actual Compose volume before copying
files; do not drop a personal archive into the repository checkout.

## Viewing your timeline in OpenMapX

### 1. The day timeline viewer

Open the Timeline panel, select a date, and verify summary, entries, and map
tracks against a known day in Dawarich. Day bounds use the account's time zone,
including daylight-saving transitions. Empty days can be valid; confirm the
selected date, time zone, and source import before diagnosing a connection fault.

### 2. Personal visit history on places

The implemented viewer displays visits within the selected day. It does not
currently provide an all-time visit-count card on arbitrary place details. Use
the day panel or Dawarich itself to inspect history.

## Privacy, rate limiting, and security

### Privacy architecture

Timeline routes use `Cache-Control: no-store, private, max-age=0` and
`Pragma: no-cache`. The application excludes timeline payloads from shared and
offline caches, suppresses sensitive request logging, and keeps lifecycle audit
details bounded. Verify your external proxy and monitoring configuration too:
those components can override headers or retain URLs independently.

Connection records and credentials remain in OpenMapX until disconnected or
handled by the relevant account/privacy workflow. Managed Dawarich data and
backups have their own retention and deletion rules.

### Rate limiting

Day reads and connection mutations use separate limits. Upstream 429 responses
produce `TIMELINE_RATE_LIMITED`; a valid bounded `Retry-After` is forwarded when
available. Wait before retrying rather than repeatedly reconnecting the same key.

## Troubleshooting and recovery

| Error                           | Action                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `TIMELINE_NOT_CONNECTED`        | Connect your key in account settings.                                                 |
| `TIMELINE_MANAGED_DISABLED`     | Check selection, provisioning, both applied generations, and app health.              |
| `TIMELINE_CREDENTIAL_INVALID`   | Verify the personal key in Dawarich and reconnect if replaced.                        |
| `TIMELINE_INSTANCE_UNSUPPORTED` | Check the HTTPS origin and supported API contract.                                    |
| `TIMELINE_PLAN_RESTRICTED`      | Check whether the source account permits the required API access.                     |
| `TIMELINE_RATE_LIMITED`         | Wait for the retry interval.                                                          |
| `TIMELINE_UPSTREAM_UNAVAILABLE` | Inspect container/network health and source availability.                             |
| `TIMELINE_RESPONSE_INVALID`     | Check API compatibility with the managed 1.19.0 baseline and bounded response limits. |

```bash
pnpm openmapx services status dawarich-app
pnpm openmapx services logs dawarich-app --tail 200
pnpm openmapx services logs dawarich-sidekiq --tail 200
```

For an interrupted OIDC change, restore vault access and run **Provision/reconcile**
again. The recovery marker must clear before applying both app and worker. A
rotation invalidates the previous OIDC secret immediately; app-only apply is
insufficient. For database or Rails conflicts, stop the whole bundle and repair
shared credentials as one coordinated maintenance operation; independent
credential edits can leave consumers inconsistent.

### Backup and restore

`backup create` captures the dedicated database as `pg_dump` and the app's
public, watched, and storage volumes as tar archives. Dawarich Redis is excluded.
Protect snapshots and retain an off-host copy:

```bash
pnpm openmapx backup create --name dawarich-pre-upgrade
pnpm openmapx backup list
```

Restore only after reviewing [Backup and restore](../administration/backup-and-restore.md),
with matching service versions and preserved deployment keys. Include both the
app file volumes and the database, and stop all Dawarich writers first:

```bash
pnpm openmapx services stop dawarich-sidekiq dawarich-app
pnpm openmapx backup restore dawarich-pre-upgrade \
  --services dawarich-app dawarich-postgis --stop-running
pnpm openmapx services start dawarich-app dawarich-sidekiq
```

Verify all four services, browser sign-in, and a synthetic point/import after a
rehearsal. External Dawarich backups are the external operator's responsibility.
A database dump does not replace preservation of the vault/encryption keys and
OpenMapX OAuth/connection state needed for full recovery.

### Disconnecting or deleting data

Disconnecting removes OpenMapX's encrypted key and connection record. It does
not delete the source history. Delete source history through Dawarich's own
account/import tools or the applicable managed privacy workflow.

To stop managed collection without deleting volumes, stop all four services,
remove the `dawarich-app` root, and render again. Confirm no separately selected
Dawarich roots remain. Do not use `compose down --volumes`: it also affects other
selected services' data. Volume purge is destructive and needs a verified backup
and exact identification of the five Dawarich volumes.
