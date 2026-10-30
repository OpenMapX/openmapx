# Managed Dawarich timeline

This operator runbook complements the published
[Dawarich setup guide](../docs/guides/dawarich.md). Use that guide for provisioning,
user API-key connection, tracking clients, and the day viewer. This file records
maintenance and release checks for the managed bundle; it is not evidence that
a particular deployment passed them.

The current manifests select Dawarich 1.19.0 for app and worker, dedicated
PostgreSQL 18/PostGIS 3.6, and dedicated Redis 8.10. Their combined memory ceilings
are 8.5 GiB before OpenMapX and host overhead. App, worker, and data images are
digest pinned. Database and Redis have no host-published ports.

## Before enabling

Provide working public HTTPS origins for OpenMapX and `timeline.<DOMAIN>` (or
the provisioned custom hostname), correct proxy routing, enough import/storage
capacity, and a protected off-host recovery plan. Review Dawarich's default
`STORE_GEODATA=true` and its reverse-geocoder disclosures before onboarding.

Verify persistence before collecting real history. In particular, compare the
running dedicated PostGIS `PGDATA` with its actual Docker mounts: the current
Dawarich manifest declares `/var/lib/postgresql/data`, while the platform's
PostgreSQL 18 manifest uses `/var/lib/postgresql`. A named-volume declaration
alone does not prove that the selected image writes its live database there.
Resolve any mismatch and prove restart/recreation and restore behavior on a
disposable instance before relying on it for retained data.

Provisioning must supply consistent database, Rails, and OIDC vault secrets and
the persisted confidential Better Auth client. Do not use plaintext environment
fallbacks or generate guessed files in `infra/docker/secrets/`.

## Provision, enable, and apply

1. Open **Admin → Services → Dawarich Timeline → Managed Dawarich setup**.
2. Choose **Provision/reconcile** and resolve conflicts before enabling.
3. Select `dawarich-app`; its dependencies include the complete bundle.
4. Apply from the admin workflow for both app and Sidekiq. Newly provisioned
   database/vault values must reach the first applied configuration generation.
5. Verify all four services and the public OIDC flow before connecting users.

Do not insert a fresh CLI render between provisioning and the first admin apply:
the CLI preserves only the last applied generation and cannot read new database/
vault values. After that first apply, host lifecycle commands retain the applied
settings.

Expected OIDC values:

```text
Issuer:       https://<DOMAIN>/api/auth
Redirect URI: https://timeline.<DOMAIN>/users/auth/openid_connect/callback
Flow:         Authorization Code with S256 PKCE
Scopes:       openid profile email
```

A custom public hostname must produce the corresponding exact callback, with no
`/dawarich-app` prefix. Inspect the rendered router and confirm neither data
service has a `ports` entry. Provisioning is retryable and must not create a
second OAuth client or rewrite consistent secrets.

The generic Credentials tab marks the shared fields **Managed** and rejects
independent mutation with `409 DAWARICH_CREDENTIAL_MANAGED`. Use the dedicated
OIDC recovery action only for deliberate rotation. Database or Rails conflicts
need coordinated maintenance with the whole bundle stopped.

OIDC rotation invalidates the previous secret immediately. A non-secret recovery
marker remains pending until both vault copies and a fresh final generation are
written. An apply racing rotation cannot satisfy readiness with an intermediate
generation. If provisioning or clearing the marker fails, restore vault access
and run **Provision/reconcile** again. It can rotate again because Better Auth
does not expose the current secret for comparison. Apply both consumers only
after recovery clears. An app-only apply cannot clear the remaining notice.

## Authentication and the user API key

OIDC gives browser sign-in, not single logout or API authorization. Retain a
verified local administrator until signed-out SSO, existing-session SSO, and
explicit same-email account linking work. Sign out of both apps on shared devices.

Every user copies their own key from Dawarich `/users/edit` into OpenMapX's
personal timeline connection. The server encrypts the key and uses it as a Bearer
token for supported read-only calls. Tracking/import writes go directly to
Dawarich. See the upstream [OIDC guide](https://dawarich.app/docs/self-hosting/configuration/oidc-authentication/)
and [API introduction](https://dawarich.app/docs/api/dawarich-api/).

## Health and logs

| Service            | Manifest health probe                           |
| ------------------ | ----------------------------------------------- |
| `dawarich-postgis` | `pg_isready -U postgres -d dawarich_production` |
| `dawarich-redis`   | `redis-cli --raw incr ping`                     |
| `dawarich-app`     | `GET /api/v1/health` on internal port 3000      |
| `dawarich-sidekiq` | `pgrep -f sidekiq`                              |

```bash
pnpm openmapx services status
pnpm openmapx services logs dawarich-app --tail 200
pnpm openmapx services logs dawarich-sidekiq --tail 200
```

The stock web entrypoint waits for PostgreSQL, applies schema/data migrations
and seeds, then starts Puma. Worker startup follows the healthy app. Health
probes alone do not establish a successful OIDC flow, working API key, import,
or backup restore.

OpenMapX connects to the managed API only at `http://dawarich-app:3000`; user links
use the public HTTPS origin. Managed availability requires installed, selected,
provisioned configuration and reachable app health. Only non-user health is
cached in memory, for at most 15 seconds. Disabling does not erase connections.

## Aggregate monitoring

The internal metrics `personal_timeline_requests_total` and
`personal_timeline_request_duration_ms` use bounded mode/operation/outcome labels.
Do not add account IDs, hostnames, dates, time zones, places, tracks, coordinates,
or upstream messages. Establish representative operational baselines before
choosing alert thresholds or an SLO. Check external proxy and log collectors as
well as application logs.

## Persistence and backups

| Named volume key               | Purpose                                          | Backup mode |
| ------------------------------ | ------------------------------------------------ | ----------- |
| `openmapx-dawarich-db-data`    | Dedicated database; verify actual `PGDATA` mount | `pg_dump`   |
| `openmapx-dawarich-public`     | App public/static files                          | tar         |
| `openmapx-dawarich-watched`    | Watched import directory                         | tar         |
| `openmapx-dawarich-storage`    | Active Storage attachments and imports           | tar         |
| `openmapx-dawarich-redis-data` | Transient jobs/cache                             | excluded    |

A PostgreSQL logical dump can succeed even if live database storage is mounted
incorrectly; prove persistence and restore separately. Retain OpenMapX OAuth and
connection state, vault encryption keys, generated secrets, deployment environment,
and required erasure-journal state through the protected recovery policy. Exclude
private subject-export artifacts from backups.

```bash
pnpm openmapx backup create --name dawarich-pre-upgrade
pnpm openmapx backup list
```

Use matching recorded Dawarich/PostGIS versions for a restore rehearsal. Stop
all writers and restore both app files and database:

```bash
pnpm openmapx services stop dawarich-sidekiq dawarich-app
pnpm openmapx backup restore dawarich-pre-upgrade \
  --services dawarich-app dawarich-postgis --stop-running
pnpm openmapx services start dawarich-app dawarich-sidekiq
```

The database container must exist for the restore workflow to start it and replay
the dump. On a new host, prepare and apply the matching provisioned configuration
first. Follow [Backup and restore](../docs/administration/backup-and-restore.md)
for retention, version/provenance checks, and isolation. Verify all four services,
sign-in, and a known synthetic point/import after restoring. Do not use real
location data for release drills.

## Image and architecture release check

Read exact image references from the four `services/dawarich-*/service.json`
files. The app and worker must share a reviewed digest and collector-compatible
revision. PostGIS provenance is recorded in
`services/postgis/image-provenance.json`; do not treat its old inspection date as
fresh runtime evidence.

Before changing image pins, inspect the candidate indexes:

```bash
docker buildx imagetools inspect freikin/dawarich:1.19.0
docker buildx imagetools inspect ghcr.io/baosystems/postgis:18-3.6
docker buildx imagetools inspect redis:8.10-alpine
```

These inspect mutable tags, while the managed manifests run pinned digests.
Review any difference rather than silently adopting tag bytes. Require native
linux/amd64 and linux/arm64 support, working stock web/Sidekiq entrypoints,
native PostgreSQL/PostGIS startup, complete migrations, persistence, privacy
collectors, and a same-version synthetic restore. Do not substitute another image
or force emulation to bypass a failed check. Bao Systems' rebuilds have no support
guarantee; see its [repository](https://github.com/baosystems/docker-postgis).

## Release acceptance

Use synthetic data, two real public HTTPS origins, trusted certificates, exact
Traefik routing, private data services, and sufficient host memory. Record the
commit, pinned images, environment, and evidence for:

1. Two provisioning runs create one OAuth client and preserve consistent secrets.
2. Signed-out and existing-session SSO complete with PKCE and the exact callback;
   same-email linking requires its explicit challenge.
3. A synthetic daylight-saving transition day renders summary, visits, journeys,
   bounds, and geometry after copying the key from `/users/edit`.
4. Browser caches/storage, application and proxy logs, audit events, and metrics
   contain no credential or synthetic history marker, dates, or coordinates.
   The browser never calls the Dawarich API directly.
5. Disable/re-enable preserves the connection without repasting the key.
6. Container recreation preserves the live database on the intended volume, and
   an empty-volume restore recovers account/history, app files, and OpenMapX
   OAuth/connection state using preserved recovery keys and ACME state.

A local trusted-CA or tunnel exercise does not replace public DNS/TLS acceptance.
The bilingual privacy/legal text also requires human/project-owner approval.
Stop release on missing acceptance, unsupported image drift, automatic same-email
linking, secret/history leakage, persistence or restore loss, or failed legal
checks. These are release conditions, not claims of checks run by editing docs.

## Upgrades

Do not change the bundle to `latest`. Read the target release notes and
[Dawarich updating guide](https://dawarich.app/docs/self-hosting/updating/), then:

1. Let active worker jobs finish and create a protected off-host backup.
2. Verify candidate images and native architectures.
3. Rehearse migration, OIDC, API compatibility, persistence, collector behavior,
   and restore on disposable synthetic data.
4. Update app/worker pins together and review their restore/collector contract.
5. Apply in a maintenance window and verify logs, health, sign-in, and a day read.

The current compatibility baseline is
[Dawarich 1.19.0](https://github.com/Freika/dawarich/releases/tag/1.19.0).

### From 1.15.3 to 1.19.0

Dawarich 1.18 and 1.19 ask for a database backup before updating, because the
first start runs migrations that cannot be rolled back and then long background
jobs: Areas become Places, tracks from the last 12 months are repaired, flight
months and digests are recalculated, and visits are detected again across each
user's whole history. Keep the worker running until those jobs finish. On a small
server, `SKIP_VISITS_FLEET_REDETECT=1` defers the full-history visit detection,
which a user can start later from Visits → Re-run detection on full history.

The bundle keeps its separate Sidekiq worker. Dawarich 1.17 can run jobs inside
the web process, but only when `SIDEKIQ_EMBEDDED=true`, which the managed app
does not set, so jobs never run twice. Redis 8.10 reads the data Redis 7.4 saved,
so queued jobs survive the update.

The privacy collectors accept only the 1.19.0 schema. A backup taken on 1.15.3
records the `dawarich-1.15.3` contract, and the backup subject export refuses it.

## Geofencing webhooks and network reach

Dawarich 1.18 lets each user send geofence arrival and departure events to a
webhook URL. The managed app runs with `SELF_HOSTED=true`, in which Dawarich
accepts private addresses and Docker service names, as it already does for the
Immich and PhotoPrism integration URLs; it blocks only cloud-metadata, multicast
and reserved ranges. Dawarich containers share the `openmapx` Docker network, so
a Dawarich user can make the worker send a signed POST with a fixed JSON body to
another OpenMapX service and read its status code and error message. Dawarich
stores, but does not show, the response body. Review this before onboarding users
you would not give that reach, and keep internal endpoints authenticated.

## Disable and purge

Stop before removing the root from the rendered stack:

```bash
pnpm openmapx services stop \
  dawarich-sidekiq dawarich-app dawarich-redis dawarich-postgis
pnpm openmapx services disable dawarich-app
pnpm openmapx compose render
pnpm openmapx services selected
```

Remove any separately selected Dawarich roots too. This preserves volumes,
OAuth client, and connection records. Re-enabling requires normal configuration
and health checks; disabling does not revoke existing Dawarich browser sessions.

Purge is destructive. Verify a backup and explicitly confirm the deployment and
exact volumes to delete. Inspect actual container/volume metadata before
removing the selection; resolve Compose project prefixes and match only the five
Dawarich volume keys above. Avoid wildcards and `compose down --volumes`.
Never delete platform PostGIS/Redis or Traefik ACME volumes as part of this purge.
Connection records and the OAuth client need separate confirmed retirement.
