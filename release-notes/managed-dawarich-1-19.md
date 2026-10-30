---
impacts: [migration, security, operator-action]
---

## What changes

The managed Dawarich bundle moves from Dawarich 1.15.3 to 1.19.0, and its dedicated Redis from 7.4 to 8.10. Dawarich 1.16 fixed a stale two-factor challenge that could switch accounts after sign-in, and shared-photo access that survived edits to the shared trip window.

On first start, Dawarich migrates its database and then runs long background jobs: it turns Areas into Places, repairs tracks from the last 12 months, recalculates flight months and digests, and detects visits again across each user's whole history. Rolling back does not undo these jobs. Redis 8 reads the data Redis 7.4 saved, so queued jobs carry over.

Dawarich 1.18 adds geofencing webhooks: a user can make Dawarich send arrival and departure events to a URL of their choice. Because the managed bundle runs Dawarich in self-hosted mode, such URLs, like the Immich and PhotoPrism URLs before them, may name private addresses. The managed Dawarich containers therefore leave the shared `openmapx` Docker network. They run on two private networks: one for the app, worker, database and Redis, and one through which only Traefik and the OpenMapX API reach the web app. Webhooks and photo URLs can no longer reach OpenMapX's database, Redis or other platform services. Outbound internet access is unchanged.

The privacy subject export now covers geofence events, webhooks and their delivery state, legacy area-to-place mappings and point/track revision counters. Webhook signing secrets, the path and query of webhook URLs, and webhook response bodies and error messages are never exported. Backups now record the `dawarich-1.19.0` schema contract; the backup subject export refuses a backup taken on 1.15.3.

## Who is affected

Installations that run the managed Dawarich bundle. External Dawarich instances connected by URL and API key are unaffected.

## Required action

Create a backup that includes the managed Dawarich state before updating, as Dawarich asks for 1.18 and 1.19. Keep the Dawarich worker running after the update until its background jobs finish; on a small server, setting `SKIP_VISITS_FLEET_REDETECT=1` defers the full-history visit detection, which a user can start later from Visits → Re-run detection on full history.

If you added your own service that reaches `dawarich-app` or the Dawarich database by name over the `openmapx` network, move it to a supported path: the private networks admit only the bundle, Traefik and the OpenMapX API.
