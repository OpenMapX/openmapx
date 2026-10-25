---
title: Supporting infrastructure
description: Operate the main PostgreSQL database, authenticated Valkey cache, and Traefik proxy.
sidebar_position: 6
---

# Supporting infrastructure

The default application stack includes PostGIS, Valkey (service ID `redis`), and
Traefik, alongside API, web, data-manager, ops-agent, well-known files, and the
private Transitous runner. Optional engines can have separate databases and
volumes. See [Managing services](../install/managing-services.md) for selection
and [Requirements](../install/requirements.md) for capacity planning.

## PostGIS {/* #postgis--the-database */}

The main database stores accounts, settings, saved places, audit records, and
imported place data. MOTIS stores compiled transit schedules on disk; PostgreSQL
holds transit lifecycle metadata. Managed Dawarich has its own database.

| Property          | Current manifest value                                 |
| ----------------- | ------------------------------------------------------ |
| Image             | `ghcr.io/baosystems/postgis:18-3.6`, pinned by digest  |
| Database / user   | `openmapx` / `postgres`                                |
| Memory limit      | `POSTGIS_MEMORY`, default `2g`                         |
| Named volume      | `openmapx-pgdata` at `/var/lib/postgresql`             |
| Internal endpoint | `postgis:5432`                                         |
| Host endpoint     | `127.0.0.1:5432`, relocatable with `POSTGIS_HOST_PORT` |

### Image provenance and release gate

The manifest pins the reviewed OCI index; `services/postgis/image-provenance.json`
records its source and architecture evidence. The tag alone is mutable. A newer
tag does not override the committed digest.

When deliberately updating the database image, compare its linux/amd64 and
linux/arm64 manifests and repeat native startup, existing-volume compatibility,
and synthetic backup/restore checks before deployment. Bao Systems provides no
support guarantee for its rebuilds. See the
[image repository](https://github.com/baosystems/docker-postgis). Do not substitute
an image or rely on emulation without reviewing volume compatibility.

### The password

Set a unique `POSTGRES_PASSWORD` in `infra/docker/.env` before the first render.
Generate one with `openssl rand -hex 32`; production rejects known placeholders,
username matches, and values shorter than 24 characters. Use hexadecimal output
to avoid database-URL escaping issues.

OpenMapX's PostGIS wrapper synchronizes this password on every start, including
an initialized volume. Its health check waits for synchronization. To rotate,
choose a maintenance window, stop database clients, edit the secret, recreate
PostGIS, verify health, then recreate clients with the same value. Restarting
only existing client containers does not reload their environment.

The wrapper forwards stop signals and allows PostgreSQL a five-minute grace
period. Do not force-kill a slow shutdown without investigating it.

### Sizing and tuning

Set the container limit with the variable the manifest actually reads:

```dotenv
POSTGIS_MEMORY=4g
POSTGIS_MAX_WAL_SIZE=4GB
POSTGIS_CHECKPOINT_TIMEOUT=15min
```

Apply during a database maintenance window:

```bash
pnpm openmapx services start postgis
```

The wrapper derives memory tuning from the container limit. Spatial imports,
Overture conflation, and extensions can make the default inadequate; measure the
workload. Larger WAL and checkpoint intervals can reduce repeated writes but
increase disk use and crash-recovery work. See
[PostgreSQL workload diagnostics](../install/managing-services.md#postgresql-workload-diagnostics)
for the separate diagnostics opt-ins and their staging requirements.

API startup applies pending schema migrations. This does not make arbitrary
older images compatible with a newer database. Preserve a matching backup when
planning rollback.

Martin uses the restricted `openmapx_tiles` login, configured with
`MARTIN_DB_PASSWORD`; it does not use the database superuser. See
[Martin overlays](./map-tiles.md#martin-overlays).

### Backups

`backup create` streams a PostgreSQL dump; restore replays it through a live
database server. Treat this data as irreplaceable and keep an independent
protected copy. Ordinary volume backups omit `.env`, secret files, and other
host recovery state. Follow [Backup and restore](../administration/backup-and-restore.md)
for version checks, erasure-journal validation, retention, and restore isolation.

## Valkey {/* #valkey--the-cache */}

The `redis` service runs Valkey `9.1.2-alpine`, pinned by digest. It retains the
Redis-compatible service ID and protocol.

| Property          | Current manifest value                            |
| ----------------- | ------------------------------------------------- |
| Memory ceiling    | `512m`                                            |
| Named volume      | `openmapx-redisdata` at `/data`, backed up as tar |
| Internal endpoint | `redis:6379`                                      |
| Host endpoint     | `127.0.0.1:6379`                                  |
| Authentication    | Renderer-generated password and hashed ACL files  |

`compose render` creates `infra/docker/secrets/redis-password` and
`redis-acl.conf`. API receives the password through a read-only file mount.
Unauthenticated `redis-cli` calls fail with `NOAUTH`; publishing only on loopback
does not remove the authentication requirement.

For a health check without printing the password:

```bash
docker compose --env-file infra/docker/.env \
  -f infra/docker/state/ops-agent/configuration/current/docker-compose.generated.yml \
  exec -T redis sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" exec redis-cli ping'
```

Expect `PONG`. The current `openmapx cache` command implementation does not load
this password file, so it can fail authentication on the managed stack. Do not
disable authentication to make it work.

Valkey holds provider caches and short-lived coordination, rate-limit, and
idempotency state. Treating every key as disposable can weaken those controls.
Avoid blanket `FLUSHDB`/`FLUSHALL` during operation; investigate a specific stale
namespace and its owner before deleting it.

To rotate the generated password, stop its clients, rotate, recreate Redis, and
restart the clients:

```bash
pnpm openmapx services stop app-api data-manager
pnpm openmapx compose rotate-redis-password --confirm-clients-stopped
pnpm openmapx services update redis --no-deps
pnpm openmapx services start app-api data-manager
```

Also stop any extension using the shared Redis credential. If rotation reports a
post-commit ACL failure, keep clients stopped, repair the reported file integrity
issue, run `compose render` to reconcile, then recreate Redis. Do not generate a
second unrelated password manually.

## Traefik {/* #traefik--the-reverse-proxy */}

Bundled Traefik `v3.7.14` is digest pinned. It publishes TCP 80/443 and UDP 443,
terminates TLS, and routes requests by hostname and path. Most other published
ports bind only to loopback; review community-service exposure independently.

Traefik uses a file provider and has no Docker socket. The ops-agent owns
privileged Docker authority. ACME state lives in the backed-up
`openmapx-traefik-acme` volume at `/etc/traefik`.

### TLS and the two variables that drive it

Set `DOMAIN` and `ACME_EMAIL` before rendering. DNS and inbound TCP port 80 must
reach Traefik for the ACME HTTP challenge; TCP 443 serves HTTPS. Publish IPv6 DNS
only when it reaches the same service correctly. HTTP/3 also needs UDP 443.

If certificates fail, inspect DNS, firewall rules, port conflicts, and proxy
logs before retrying. Repeated ACME attempts can hit upstream limits.

A default deployment exposes routed pages publicly. For staging basic auth, add
two [overrides](../install/managing-services.md#service-file-overrides) in
`infra/docker/overrides/services/traefik/config/`:

- `dynamic/auth.yml`: a copy of `services/traefik/config/dynamic/auth.yml.example`
  with your own hash, mode 0600;
- `traefik.yml`: a copy of `services/traefik/config/traefik.yml` with
  `basic-auth@file` appended to the existing middleware list.

Render the stack, then recreate Traefik, which reads `traefik.yml` only when it
starts; the middleware file alone does not activate it.

### Where Traefik reads its configuration

Traefik watches its dynamic directory and reloads a file as soon as it
changes, so that directory is a stable one in the operations agent's state,
`infra/docker/state/ops-agent/traefik/dynamic`. Rendering writes
`generated-routes.yml` there from validated service exposure declarations,
beside the release's YAML and TOML files of `services/traefik/config/dynamic`
(`middlewares.yml`) and your overrides of that directory (`auth.yml`), each
replaced atomically. The static `traefik.yml`, which Traefik reads when it
starts, is copied into each configuration generation, from the release or your
override. Change either through
[overrides](../install/managing-services.md#service-file-overrides); do not
edit the copies or the generated routes. A file removed from your overrides is
removed from Traefik's directory by the next render.

The directory is owner-only (0700, files 0600, `auth.yml`'s password hashes
included). The Traefik image runs as root, which reads it through the
capabilities Docker grants by default.

A Traefik started before this layout reads `services/traefik/config/dynamic`
until it is recreated. Render keeps writing the routes there while any
container still mounts that directory, and render, check and **Run
diagnostics** say so. Recreate Traefik when a few seconds without the proxy
suit you: `pnpm openmapx services update traefik`, or **Recreate** on
**Admin → Services → Traefik**.

| Public path         | Target                       |
| ------------------- | ---------------------------- |
| `/api/*`, `/health` | `app-api`                    |
| `/api/internal/*`   | Explicit deny middleware     |
| `/.well-known/*`    | `well-known`                 |
| `/tiles/*`          | TileServer GL, when selected |
| `/martin/*`         | Martin, when selected        |
| Other paths         | `app-web`                    |

Managed Dawarich has a separate `timeline.<DOMAIN>` hostname. Community services
do not automatically receive a platform route.

For an operator-run Traefik, use the
[external proxy procedure](../install/managing-services.md#behind-an-existing-reverse-proxy).
That mode uses Docker labels on the external network and requires the referenced
file middlewares, including the internal-API deny rule. Match encoded-path
settings so opaque place and stop IDs continue to work.

## Where to go next

See [Configuration](../install/configuration.md) for deployment variables,
[Upgrading](../install/upgrading.md) for image changes, and
[Backup and restore](../administration/backup-and-restore.md) for recovery.
