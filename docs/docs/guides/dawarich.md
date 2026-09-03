---
title: Self-hosting location history (Dawarich)
description: Run your own private location history server with Dawarich, record tracks via mobile apps, import Google Takeout, and view personal timelines and visit history in OpenMapX.
sidebar_position: 8
---

# Self-hosting location history with Dawarich

OpenMapX is built on a clear privacy principle: the map never tracks you, logs
your location, or maintains a central database of your movements. But many
people value having a private record of where they have been — what Google
called Location History or Timeline — provided they own the data and host the
server themselves.

To support this without compromising the core map's privacy boundary, OpenMapX
integrates with [Dawarich](https://dawarich.app/), an open-source, self-hosted
location history and personal timeline application created by Artem Freik.

This guide explains how Dawarich works, how to run the managed Dawarich stack
inside OpenMapX, how to connect an existing external Dawarich instance, how to
send location data from your phone or import past history, and how OpenMapX
surfaces your timeline and place visit history.

If you only want to know how the timeline looks to a user, see the
[Personal timeline feature guide](../features/personal-timeline.md).

## How Dawarich fits into OpenMapX

The division of responsibility between OpenMapX and Dawarich is strict:

- **Dawarich owns data collection and storage.** Dawarich receives GPS points
  from mobile tracking apps, aggregates points into stationary **visits** and
  moving **trips**, performs reverse geocoding to identify named places, and
  stores your complete location history in a dedicated PostGIS database.
- **OpenMapX is a read-only presentation client.** OpenMapX never collects GPS
  points, tracks your background movements, writes to Dawarich, or stores your
  location history in its own database.
- **Fetched timeline data is strictly ephemeral.** When you view a day in
  OpenMapX, the server requests that single day's summary, visits, and tracks
  from the Dawarich REST API using your personal API key. The payload is
  rendered in the browser session and discarded. It is **never** written to the
  OpenMapX PostgreSQL database, never cached in Redis or shared caches, and
  never stored in the offline Service Worker cache.

```mermaid
graph LR
    subgraph Mobile["Location Collection"]
      App["Dawarich Mobile<br/>OwnTracks · Overland"]
    end

    subgraph Dawarich["Dawarich Stack (Port 3000 · timeline.domain)"]
      DApp["dawarich-app (Rails)"]
      DSidekiq["dawarich-sidekiq (Worker)"]
      DDB[("dawarich-postgis<br/>Location records · visits · trips")]
      DRedis[("dawarich-redis")]
      DApp <--> DSidekiq
      DApp <--> DDB
      DApp <--> DRedis
    end

    subgraph OpenMapX["OpenMapX Core"]
      API["app-api"]
      Web["app-web (Browser)"]
    end

    App -->|POST /api/v1/points (GPS)| DApp
    Web -->|GET /api/timeline/day/:date| API
    API -->|GET /api/v1/timeline (read-only)| DApp
```

## Managed bundle vs. external instance

You can use Dawarich with OpenMapX in either of two ways:

| | **Managed Dawarich bundle** | **External Dawarich instance** |
| --- | --- | --- |
| **Where it runs** | Containers inside your OpenMapX Docker stack | Any external server or existing Dawarich instance |
| **Domain** | Automatic subdomain `timeline.<DOMAIN>` | Your instance's HTTPS origin (e.g. `https://timeline.example.org`) |
| **Single Sign-On** | One-click sign-in via OpenMapX Better Auth OIDC | Dawarich's native authentication or external IdP |
| **Backups** | Managed by `openmapx backup` (`pg_dump` of database) | Managed independently by the external instance operator |
| **Updates** | Staged and updated through OpenMapX maintenance | Updated independently |
| **Good for** | All-in-one self-hosting on a single machine | Existing Dawarich users, or multi-host topologies |

Both modes present the identical experience inside OpenMapX: a day-by-day
timeline viewer on the map and personal visit history badges in place panels.

---

## The managed Dawarich stack

OpenMapX ships with a production-ready, four-container Dawarich bundle:

1. **`dawarich-app`**: The Dawarich web server running Puma on Ruby on Rails
   (`freikin/dawarich:1.10.3`). Exposes port `3000` internally and is routed by
   Traefik at `timeline.<DOMAIN>`.
2. **`dawarich-sidekiq`**: The asynchronous background worker running Sidekiq.
   It processes incoming GPS point batches, groups points into stays and visits,
   performs reverse geocoding, imports background files, and manages data
   retention.
3. **`dawarich-postgis`**: A dedicated PostgreSQL 17 database with PostGIS 3.5
   (`ghcr.io/baosystems/postgis:17-3.5`). Database name: `dawarich_production`.
   Data lives in the `openmapx-dawarich-db-data` volume.
4. **`dawarich-redis`**: A dedicated Valkey 8 instance (`valkey/valkey:8.1.5-alpine`)
   providing Sidekiq job queues and transient caching. Data lives in the
   `openmapx-dawarich-redis-data` volume.

In addition, three shared Docker volumes connect the web app and Sidekiq worker:
- `openmapx-dawarich-public` (`/var/app/public`) — static compiled assets and uploads;
- `openmapx-dawarich-watched` (`/var/app/tmp/imports/watched`) — watched directory for automated file imports;
- `openmapx-dawarich-storage` (`/var/app/storage`) — Active Storage files.

### Resource requirements

Dawarich is lightweight when idle, but file imports and batch processing can
utilize noticeable memory and CPU:

- **RAM**: ~2 GB baseline for the four containers combined (App: ~512 MB,
  Sidekiq: ~512 MB, PostGIS: ~1 GB, Valkey: ~128 MB).
- **Disk**: Dependent on your point volume. A year of continuous 1-minute
  logging typically consumes 500 MB to 2 GB of database storage.
- **CPU**: Minimal during regular tracking; multithreaded spikes when importing
  large Google Takeout archives.

---

## Deploying managed Dawarich

### Step 1: Configure DNS

Dawarich is exposed on a dedicated subdomain. In your DNS provider, create an
**A** (or CNAME) record for:

```text
timeline.<your-domain.com>  ->  <Your Server IP>
```

Traefik watches for this subdomain automatically and routes traffic to
`dawarich-app:3000` with automated Let's Encrypt TLS certificates.

### Step 2: Start the services

Start the Dawarich services using the `openmapx` CLI:

```bash
pnpm openmapx services start dawarich-app dawarich-sidekiq dawarich-postgis dawarich-redis
```

Alternatively, navigate to **Admin panel → Services → Catalog**, find the
Dawarich services, and click **Start**.

The Compose renderer automatically provisions three cryptographically random
secrets in `infra/docker/secrets/`:
- `dawarich-database-password` — database authentication;
- `dawarich-secret-key-base` — Rails session and cookie encryption key;
- `dawarich-oidc-client-secret` — Better Auth OIDC client secret.

The service entrypoint (`openmapx-entrypoint.sh`) validates and injects these
secrets at runtime without exposing them on the process command line or in
Docker inspection metadata.

### Step 3: Verify Single Sign-On (OIDC)

Once running, visit `https://timeline.<your-domain.com>`.

You will see the Dawarich login page featuring a **Sign in with OpenMapX**
button. Clicking it authenticates you through OpenMapX's Better Auth provider.
Because `OIDC_AUTO_REGISTER=true` is set, your Dawarich user account is created
automatically on first login, mapped to your OpenMapX username and email.

> [!TIP]
> Keep a verified local Dawarich administrator password configured in Dawarich
> as a recovery login in case you ever need emergency direct database or
> admin access.

---

## Connecting Dawarich to OpenMapX

Even when running the managed bundle, OpenMapX requires you to link your
personal Dawarich API key. This guarantees that OpenMapX accesses only your
individual timeline records, respecting Dawarich's multi-user isolation.

### Step 1: Copy your Dawarich API key

1. Log into your Dawarich web interface (`https://timeline.<your-domain.com>` or
   your external instance).
2. Go to **Account Settings** (click your profile icon or visit `/users/edit`).
3. Under the **API key** section, copy your personal API key (or click
   **Generate** if one has not been generated yet).

### Step 2: Link the key in OpenMapX

1. In OpenMapX, open **Account Settings** (click your avatar at top right) and
   scroll to **Personal Timeline**.
2. Select your mode:
   - **Managed Dawarich**: If your server administrator has enabled the managed
     services on your instance.
   - **External instance**: If connecting a separate server. Enter the full
     HTTPS URL (e.g. `https://timeline.example.org`). Plain HTTP, localhost,
     and private IP ranges are rejected for security unless explicitly allowlisted
     by the operator.
3. Paste your Dawarich API key into the credential field and click **Connect**.

OpenMapX immediately performs two validation calls against Dawarich:
- `GET /api/v1/users/me` to confirm the key is active and matches your identity;
- `GET /api/v1/settings` to retrieve your preferred time zone and distance unit
  (kilometres or miles).

When validation succeeds, OpenMapX encrypts the API key with
`OPENMAPX_SECRETS_KEY` and stores the connection record in PostgreSQL. The raw
key is never sent back to the browser.

---

## Recording your location history

Dawarich can receive location updates from background mobile apps or import
historical datasets.

### Continuous mobile tracking

#### 1. Official Dawarich mobile app (iOS & Android)
The official Dawarich app is the easiest way to log movements:
- Download Dawarich from the Apple App Store or Google Play.
- Enter your instance URL (`https://timeline.<your-domain.com>`).
- Paste your Dawarich API key and enable background tracking.

#### 2. OwnTracks (iOS & Android)
[OwnTracks](https://owntracks.org/) is a mature, open-source background tracking
client:
1. In OwnTracks preferences, select **HTTP mode**.
2. Set the **Host URL** to:
   ```text
   https://timeline.<your-domain.com>/api/v1/owntracks/points?api_key=<YOUR_DAWARICH_API_KEY>
   ```
3. Set your Tracker ID (e.g. `me`) and enable **Move mode** or **Significant
   changes**.

#### 3. Overland (iOS)
[Overland](https://overland.p3k.app/) batches GPS points efficiently:
1. In Overland settings, set the receiver endpoint to:
   ```text
   https://timeline.<your-domain.com>/api/v1/overland/batches?api_key=<YOUR_DAWARICH_API_KEY>
   ```
2. Overland will automatically queue and upload points in power-efficient
   batches.

### Importing past history (Google Takeout, GPX, Strava)

If you have years of location data in Google Maps Timeline, you can import it
directly into Dawarich:

1. Export your location history using [Google Takeout](https://takeout.google.com/).
   Select **Location History (Timeline)** and choose JSON format.
2. In Dawarich, open **Imports** from the sidebar.
3. Choose **Google Takeout** and upload your `Records.json` or year-by-year
   Semantic Location History folders.
4. Dawarich's Sidekiq worker will process the records in the background,
   reverse-geocoding places and building your historical trips.
5. You can also import standalone `.gpx`, `.kml`, or `.geojson` track files, or
   connect your Strava account.

> [!NOTE]
> For very large Google Takeout archives (multiple gigabytes), you can place
> the files directly into the watched import volume on the host at
> `/var/app/tmp/imports/watched` (`openmapx-dawarich-watched`). Dawarich
> automatically picks up and processes files dropped into that directory.

---

## Viewing your timeline in OpenMapX

Once your connection is active and Dawarich contains data:

### 1. The day timeline viewer
Click the **Timeline** icon in the map sidebar or open the user menu and select
**Your timeline**:
- **Date navigation**: Step through days with the calendar picker. OpenMapX
  reads the local day bounds according to your Dawarich time zone, accurately
  handling daylight saving transition days (23- or 25-hour days).
- **Day summary**: Displays total distance travelled, active moving time, and
  number of distinct places visited.
- **Visits and journeys**: The left panel lists each stop chronologically with
  arrival and departure times, duration, and the reverse-geocoded place name.
- **Interactive map trace**: Your actual travel path is rendered as a clean,
  color-coded route line on top of the OpenMapX vector basemap, with distinct
  puck markers at stationary visit locations.

### 2. Personal visit history on places
When you search for or click any café, park, restaurant, or address in OpenMapX,
the place detail panel displays a **Visits** card showing:
- How many times you have visited that location;
- The date of your most recent visit;
- Links to jump straight to that day in your timeline viewer.

This transforms OpenMapX into a personal spatial memory tool without sharing
any of your visit data with external search providers or advertisers.

---

## Privacy, rate limiting, and security

### Privacy architecture
- **No coordinate retention**: OpenMapX does not retain coordinates, geometry,
  or place visits from Dawarich in its database.
- **Cache-Control: no-store**: All `/api/timeline/*` HTTP endpoints transmit
  `Cache-Control: no-store, private, max-age=0` and `Pragma: no-cache` headers.
  Intermediaries, reverse proxies, and browsers are forbidden from storing
  timeline data on disk.
- **Audit isolation**: OpenMapX audit logs record that a user accessed their
  timeline, but strip all query parameters, coordinates, dates, and response
  payloads.

### Rate limiting
To prevent accidental denial-of-service against self-hosted Dawarich backends:
- Personal timeline day reads run on a dedicated rate-limit bucket
  (`timelineDayApiLimit`).
- Connection mutation actions (`PUT`, `DELETE`, `POST /test`) are governed by
  expensive rate limits.
- When Dawarich returns HTTP `429 Too Many Requests`, OpenMapX extracts the
  upstream `Retry-After` header, returns code `TIMELINE_RATE_LIMITED`, and
  instructs the UI to pause requests.

---

## Troubleshooting and recovery

If the timeline panel reports an error, consult the table below:

| Error code | Meaning | Recommended action |
| --- | --- | --- |
| `TIMELINE_NOT_CONNECTED` | No Dawarich instance is linked to this account. | Open Account Settings → Personal Timeline and connect your API key. |
| `TIMELINE_MANAGED_DISABLED` | Managed Dawarich services are stopped or unhealthy. | Check `pnpm openmapx services status` or start the containers in Admin → Services. |
| `TIMELINE_CREDENTIAL_INVALID` | Dawarich rejected the API key (HTTP 401). | Verify the key in Dawarich (`/users/edit`), regenerate if necessary, and reconnect. |
| `TIMELINE_RATE_LIMITED` | Dawarich or OpenMapX rate limit exceeded. | Wait for the indicated retry countdown before requesting further days. |
| `TIMELINE_UPSTREAM_UNAVAILABLE` | Dawarich container or external host is unreachable. | Ensure `dawarich-app` is running and healthy on port 3000. |
| `TIMELINE_RESPONSE_INVALID` | Upstream payload violates the expected schema. | Check that your Dawarich version is compatible (v1.10.x recommended). |

### Backup and restore

When taking a regular platform backup via `pnpm openmapx backup create`:
- The `dawarich-postgis` database volume is dumped consistently via streamed
  `pg_dump` into `infra/docker/backups/<name>/dawarich-postgis.sql.gz`.
- The storage and public asset volumes are snapshotted via compressed `tar`.
- To restore Dawarich data alongside your OpenMapX instance, use:
  ```bash
  pnpm openmapx backup restore <snapshot-name> --services dawarich-postgis --stop-running
  ```

### Disconnecting or deleting data

- **Disconnecting**: In OpenMapX Account Settings, click **Disconnect**. OpenMapX
  purges your encrypted API key and connection record from the database.
  Your location history inside Dawarich is completely untouched.
- **Purging data**: To delete your location history, use Dawarich's native
  account management tools at `https://timeline.<your-domain.com>/users/edit`
  or wipe specific imports/points directly within Dawarich.
