# Managed Dawarich timeline

OpenMapX can run an optional shared, multi-user [Dawarich](https://dawarich.app/)
1.10.3 instance for timeline users. The bundle uses stock Dawarich application
code and consists of four isolated services:

- `dawarich-app` — Rails/Puma web application, 4 GiB memory limit;
- `dawarich-sidekiq` — background worker with concurrency 3, 2 GiB limit;
- `dawarich-postgis` — dedicated PostgreSQL 17/PostGIS 3.5, 2 GiB limit and
  1 GiB shared memory;
- `dawarich-redis` — dedicated Redis 7.4 queue/cache, 512 MiB limit.

Selecting `dawarich-app` selects all four services and Traefik. PostgreSQL,
Redis, and Sidekiq remain private on the Compose network. Only the app is
published, at `https://timeline.<DOMAIN>` with TLS provided by Traefik.

This service is separate from OpenMapX's own PostgreSQL and Valkey instances.
It does not share schemas, cache keys, cookies, database credentials, or data
volumes with the platform services.

## Before enabling

Plan for at least 8.5 GiB of container memory plus Docker and host overhead.
Location history and attachments grow over time, so size storage and off-host
backups for the expected user count and import volume. The app's default
`STORE_GEODATA=true` may send coordinates to the configured Dawarich reverse
geocoder; review that privacy trade-off before onboarding users.

Create public DNS for `timeline.<DOMAIN>` pointing to the OpenMapX host. Ports
80 and 443 must reach Traefik so it can obtain and serve a certificate. Do not
publish the Dawarich PostgreSQL or Redis ports.

The managed bundle also requires the Better Auth confidential OAuth client and
the following vault-backed secrets before it can start:

- a single database password, supplied to `dawarich-postgis` as
  `POSTGRES_PASSWORD` and to the app and worker as `DATABASE_PASSWORD`;
- the same Rails `SECRET_KEY_BASE` for the app and worker;
- the same Better Auth `OIDC_CLIENT_SECRET` for the app and worker;
- the non-secret OAuth client ID as `OIDC_CLIENT_ID` for the app and worker.

OpenMapX renders secrets as files below `/run/secrets`; they never appear as
literal values in generated Compose YAML. Minimal audited wrappers read those
three Dawarich files and then execute the stock 1.10.3 web and Sidekiq
entrypoints. Do not add plaintext environment fallbacks.

## Provision, enable, and apply

Open the **Dawarich** service detail in the OpenMapX admin service catalog. In
**Managed Dawarich setup**, optionally enter the public hostname, then select
**Provision/reconcile**. The operation runs under a database lock, creates or
reconciles one persisted Better Auth client, writes file-backed secrets, and
stores non-secret service config. It is safe to retry and deliberately does not
start containers or delete data. It must produce these exact values:

```text
Issuer:       https://<DOMAIN>/api/auth
Redirect URI: https://timeline.<DOMAIN>/users/auth/openid_connect/callback
Flow:         Authorization Code
PKCE:         S256
Scopes:       openid profile email
```

Provisioning must finish writing all vault secrets before the bundle is
enabled. A retry reconciles the existing client; it must not create a second
client, rotate a consistent client secret, or reveal credential material in the
UI, response, audit event, log, metric, or generated Compose YAML. A partial or
conflicting database/Rails secret is a blocking operator conflict, not something
the reconciler guesses how to repair. The collapsed OIDC recovery action is only
for an explicit rotation: it invalidates the old secret immediately and requires
**Apply changes** on both **Dawarich Timeline** and **Dawarich Sidekiq** afterward.
OpenMapX stores an opaque, non-secret provisioning generation in both service
configs and compares it with the two running containers. The apply notice
therefore survives page/API restarts and remains pending after an app-only apply;
it clears only when both containers run the same current generation. The marker
never contains or hashes credential material.

OIDC creation and rotation also set a raw, non-secret recovery marker on both
consumers before Better Auth changes. Its value is not part of the public
service schema, response payload, generated Compose environment, or container
environment; the admin status exposes only a recovery-required boolean. It
remains set while both vault copies are written and a fresh final provisioning
generation is stored for both consumers; only then is it cleared. An **Apply**
that races the rotation can therefore load only the interim generation and
cannot satisfy readiness after rotation completes. If a write, finalization, or
clear fails, **Apply** cannot clear recovery readiness—even if both containers
later run a staged generation. Restore vault access and use
**Provision/reconcile** again; OpenMapX will rotate once more because Better
Auth intentionally does not expose a secret value that could be compared with
the vault, synchronize both copies, store another fresh final generation, and
clear the marker before Apply is safe.

The generic **Credentials** tab reports the database, Rails, and OIDC fields as
**Managed** and does not offer Set, Rotate, or Remove actions. Its API returns
`409 DAWARICH_CREDENTIAL_MANAGED` for those fields, including the PostGIS
password. This boundary prevents one service from receiving a shared credential
without the other consumers and prevents an arbitrary OIDC value from diverging
from Better Auth. Rotate OIDC only with the dedicated recovery action. Treat a
database or Rails credential conflict as host-level maintenance: stop the whole
bundle, repair the database role or affected vault rows as one coordinated
operation, then run **Provision/reconcile** and apply both the app and Sidekiq.
Do not use per-service credential rotation for managed Dawarich secrets.

From the admin service catalog, select **Dawarich Timeline**, review the
resource requirements, then use **Save & Apply** for both the timeline app and
Sidekiq worker. The admin render is required after provisioning because it reads
the service-config database and credential vault. Do not run a fresh CLI render
between provisioning and this first admin apply: the CLI intentionally has no
database/vault access. A CLI-only selection/render sequence before provisioning
is:

```bash
pnpm openmapx services enable dawarich-app
pnpm openmapx compose render --domain example.org
docker compose -f infra/docker/docker-compose.generated.yml config --quiet
pnpm openmapx compose up --domain example.org
```

The selection expands to the app, Sidekiq, dedicated PostGIS, dedicated Redis,
and Traefik. Inspect the generated file before starting: its router rule must be
`` Host(`timeline.example.org`) `` with no `/dawarich-app` path prefix, and neither
data service may have a `ports` entry.

## Authentication and the user API key

Better Auth OIDC gives an already signed-in OpenMapX user single sign-on to the
managed Dawarich web application. Dawarich still owns its own browser cookie,
so this is not single logout; on shared devices, sign out of both applications.

OIDC authenticates the browser only. Dawarich 1.10.3 does not authorize its API
with the Better Auth token or Rails session. Every user must open Dawarich,
finish OIDC registration or explicit account linking, copy their personal
Dawarich API key from **Account settings** at `/users/edit`, and paste it into
OpenMapX Timeline settings. (`/settings` is not a web account route in Dawarich
1.10.3.) OpenMapX stores that key encrypted and uses it only as a Bearer token
for read-only timeline calls. Tracking, imports, edits, and other writes go
directly to Dawarich.

The bundle keeps `ALLOW_EMAIL_PASSWORD_REGISTRATION=true` and local login
available as a verified recovery path. Do not disable the last working local
administrator until OIDC sign-in and account linking have been tested. An
existing Dawarich account with the same email may require Dawarich's explicit
linking flow.

See the upstream [OIDC guide](https://dawarich.app/docs/self-hosting/configuration/oidc-authentication/),
[API introduction](https://dawarich.app/docs/api/dawarich-api/), and the
[Better Auth OAuth Provider documentation](https://better-auth.com/docs/plugins/oauth-provider).

## Health and logs

Healthy startup order is PostGIS and Redis, then the web app, then Sidekiq. The
checks are:

- PostGIS: `pg_isready -U postgres -d dawarich_production`;
- Redis: `redis-cli --raw incr ping`;
- app: HTTP `GET /api/v1/health` on port 3000;
- Sidekiq: `pgrep -f sidekiq`.

Use the Services admin page or the CLI:

```bash
pnpm openmapx services status dawarich-postgis
pnpm openmapx services status dawarich-redis
pnpm openmapx services status dawarich-app
pnpm openmapx services status dawarich-sidekiq
pnpm openmapx services logs dawarich-app --tail 200
pnpm openmapx services logs dawarich-sidekiq --tail 200
```

The app's stock entrypoint waits for PostgreSQL, runs schema and data
migrations, runs seeds, and starts Puma. Repeating startup at the same pinned
version is expected and migration-idempotent. The worker waits for PostgreSQL
and then starts stock Sidekiq.

OpenMapX considers the managed user flow available only when the exact bundle is
installed, selected, provisioned with a validated public HTTPS origin, and the
app is reachable. It calls Dawarich APIs through the internal
`http://dawarich-app:3000` origin only; user links use the public HTTPS origin.
Only the non-user `/api/v1/health` result is cached in memory, for at most 15
seconds. Disabling or an unhealthy probe returns `TIMELINE_MANAGED_DISABLED` to
existing users without deleting their connection.

## Aggregate monitoring

The internal Prometheus endpoint exports `personal_timeline_requests_total` and
`personal_timeline_request_duration_ms`. Suggested dashboards may split only by
the closed `mode`, `operation`, and `outcome` labels. Do not add account IDs,
hostnames, dates, time zones, upstream messages, places, tracks, or coordinates.
No alert threshold or SLO is defined until representative operational baseline
data exists.

## Persistence and backups

Dawarich persistence uses five named volumes:

| Volume | Purpose | Backup mode |
| --- | --- | --- |
| `openmapx-dawarich-db-data` | PostgreSQL/PostGIS location data and accounts | `pg_dump` |
| `openmapx-dawarich-public` | public/static application files | `tar` |
| `openmapx-dawarich-watched` | watched import drop directory | `tar` |
| `openmapx-dawarich-storage` | Active Storage attachments/imports | `tar` |
| `openmapx-dawarich-redis-data` | transient queues and caches | none |

Backups record the producing service version. A valid Dawarich backup contains
app version `1.10.3` and PostGIS version `17-3.5`. Redis is deliberately not a
backup target: jobs and caches are transient and are rebuilt after restore.

Create and copy a backup off-host before upgrades or destructive maintenance:

```bash
pnpm openmapx backup create --name dawarich-pre-upgrade
pnpm openmapx backup list
```

Restore only into the exact recorded Dawarich/PostGIS versions. Start an empty
`dawarich-postgis` service first because `pg_dump` restore needs a live server,
then restore the app and database targets:

```bash
pnpm openmapx backup restore dawarich-pre-upgrade \
  --services dawarich-app dawarich-postgis \
  --stop-running
```

Start the same pinned bundle, wait for all four health checks, and confirm a
known synthetic user/point or import. A release is not approved until this
synthetic backup/restore drill passes. Never use production location data for a
release drill.

OpenMapX's volume backup does not replace an export strategy for irreplaceable
location history. Retain off-host backups and follow Dawarich's official
[backup and restore guidance](https://dawarich.app/docs/self-hosting/maintenance/backup-and-restore/).

## Image and architecture release check

| Component | Reviewed release | Reviewed OCI index / source | Native architectures tested or inspected | Support note |
| --- | --- | --- | --- | --- |
| OpenMapX | dependency-complete baseline `1a2d0396fb97b1957a6907ef41877f91cab640eb` plus this release change | repository source | CI targets plus staging host | Record the final release commit with acceptance evidence |
| Better Auth OAuth Provider | `better-auth` and `@better-auth/oauth-provider` 1.6.25 | exact package lock | server runtime | One persisted confidential client; admin API only, no direct table writes |
| Dawarich app + worker | `freikin/dawarich:1.10.3` | `sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b` | linux/amd64, linux/arm64, linux/arm/v7 inspected; arm64 entrypoints exercised | Upstream Dawarich release |
| Dedicated PostGIS | `ghcr.io/baosystems/postgis:17-3.5` | index `sha256:789ecd05031a4f98b06d6e48e0d9be054fd4c5df2cd8b14ef967bad24f359a07`; Bao revision `603ccfa15a094bf677524275bdf7e8a7478885ce` | linux/amd64 + linux/arm64 inspected; native arm64 PostgreSQL 17.5/PostGIS 3.5.2 exercised | Bao rebuilds weekly and explicitly provides no support |
| Dedicated Redis | `redis:7.4-alpine` | mutable pinned release tag; re-inspect before release | linux/amd64 + linux/arm64 inspected | Transient queues/cache; not restored |

The application manifest pins the human-readable `freikin/dawarich:1.10.3`
tag. On 2026-08-09 its OCI index was verified as linux/amd64, linux/arm64, and
linux/arm/v7 at digest
`sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b`.
The native arm64 image exposed Docker ENTRYPOINT `bundle exec` and executable
stock `/usr/local/bin/web-entrypoint.sh` and
`/usr/local/bin/sidekiq-entrypoint.sh` paths.

Dawarich's official `postgis/postgis:17-3.5-alpine` dependency is amd64-only.
The managed bundle deliberately uses the Dawarich-documented
`ghcr.io/baosystems/postgis:17-3.5` instead. Bao Systems rebuilds the upstream
Debian PostGIS images weekly as multi-architecture images, but explicitly
provides **no support** for them.

On 2026-08-09 the Bao tag was a linux/amd64 + linux/arm64 index at
`sha256:789ecd05031a4f98b06d6e48e0d9be054fd4c5df2cd8b14ef967bad24f359a07`,
built on 2026-08-04 from Bao source revision
`603ccfa15a094bf677524275bdf7e8a7478885ce`. A native Apple-arm64 smoke test
reported `aarch64`, PostgreSQL 17.5 readiness, and PostGIS 3.5.2 loading. The
Redis `7.4-alpine` index was also checked for linux/amd64 and linux/arm64.

These tags are mutable. Before every OpenMapX release, rerun:

```bash
docker buildx imagetools inspect freikin/dawarich:1.10.3
docker buildx imagetools inspect ghcr.io/baosystems/postgis:17-3.5
docker buildx imagetools inspect redis:7.4-alpine
```

Stop the release for dependency review if the Bao digest moved, either required
architecture disappeared, either Dawarich stock entrypoint path changed, or a
native PostgreSQL/PostGIS smoke fails. Do not silently choose another image or
force emulation. Re-run the full synthetic restore drill because the Bao image
has no support guarantee. See the [Bao Systems repository](https://github.com/baosystems/docker-postgis)
and Dawarich's [updating guide](https://dawarich.app/docs/self-hosting/updating/).

## Release acceptance

Use synthetic data only. The release rehearsal must use two real public HTTPS
origins (OpenMapX and `timeline.<domain>`) with trusted certificates, exact
Traefik routing, no database/cache ports, and enough host memory for the full
stack. Prove all of the following before release:

1. provisioning twice creates one OAuth client and does not rewrite consistent
   secrets;
2. signed-out SSO, existing OpenMapX-session SSO, and the explicit same-email
   account-link challenge all complete with PKCE and the exact callback;
3. a synthetic day spanning a daylight-saving transition renders visits,
   journey, bounds and track geometry after copying the key from `/users/edit`;
4. browser Cache Storage, IndexedDB, local/session storage, OpenMapX logs, audit
   events, metrics and Traefik access logs contain no key, synthetic history
   marker, date, or coordinates, and the browser never calls the Dawarich API;
5. disable/re-enable preserves the connection without repasting the key; and
6. a same-version empty-volume restore recovers the OpenMapX OAuth/connection
   state, Dawarich account/history, and app volumes using the preserved external
   environment, encryption keys and ACME state.

A local trusted-CA or tunnel rehearsal does not replace the public DNS/TLS gate.
The bilingual privacy/legal text also requires explicit human/project-owner
approval. Stop release on image drift, automatic same-email linking, credential
or timeline leakage, restore loss, failed automated legal gates, or absent legal
approval.

## Upgrades

Never auto-update to `latest`. Read the target release notes and Dawarich
updating guide, then test the app and worker together against the existing API
contract, OIDC flow, migrations, health checks, and a full synthetic restore.

1. Wait for active Sidekiq jobs to finish.
2. Create and copy an off-host backup.
3. Verify the new app and PostGIS image indexes and native architectures.
4. Run a disposable upgrade and restore rehearsal.
5. Update the app and worker tags together and update the documented restore
   version.
6. Apply the manifests and watch app/worker logs through health.

The [Dawarich 1.10.3 release](https://github.com/Freika/dawarich/releases/tag/1.10.3)
is the compatibility baseline for this bundle.

## Disable and purge

Disabling is reversible. Stop the four Dawarich services, remove
`dawarich-app` from the root selection, and re-render. This preserves all five
volumes, the Better Auth OAuth client, and users' OpenMapX timeline connection
records:

```bash
pnpm openmapx services stop \
  dawarich-sidekiq dawarich-app dawarich-redis dawarich-postgis
pnpm openmapx services disable dawarich-app
pnpm openmapx compose render
```

Re-enabling the root service reconnects the preserved data after normal key and
health validation. Disabling does not revoke the OAuth client and does not
promise that Dawarich browser sessions have ended.

Purge is a separate destructive operation. First create and verify a backup,
disable the bundle, and obtain an explicit second confirmation naming the
deployment. Use `docker compose config --volumes` to resolve the Compose project
prefix, then delete **only** the resolved forms of these five keys:

```text
openmapx-dawarich-db-data
openmapx-dawarich-redis-data
openmapx-dawarich-public
openmapx-dawarich-watched
openmapx-dawarich-storage
```

Do not use a wildcard, do not remove platform `openmapx-pgdata` or
`openmapx-redisdata`, and do not include the Traefik ACME volume. Volume deletion
is permanent; connection records and the OAuth client require their own
separately confirmed retirement flow.
