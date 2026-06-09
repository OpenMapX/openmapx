---
title: Supporting infrastructure
description: The always-on core services every deployment runs — the PostGIS database, the Valkey cache, and the Traefik reverse proxy.
sidebar_position: 6
---

# Supporting infrastructure

Most of what OpenMapX runs is optional. Routing engines, geocoders, transit
engines, the OSM query backend, and the tile server are all opt-in — you enable
the ones you want and leave the rest off. Three services are different: they are
selected by default and start with every deployment, because the rest of the
stack assumes they're there. This page covers those three.

- **PostGIS** — the primary datastore. Every container that persists anything
  writes here.
- **Valkey** — the cache, a drop-in Redis replacement. Everything in it is
  derived and expendable.
- **Traefik** — the reverse proxy, and the only service that faces the public
  internet.

They sit alongside `app-api`, `app-web`, `well-known`, and `data-manager` in the
always-on core; [Managing services](../install/managing-services.md) explains how
the core is selected and rendered, and [How it works](../overview/how-it-works.md)
covers the service model these three plug into. None of them needs a build step
or any source data — they boot from their image and are ready.

## PostGIS — the database

The `postgis` service is PostgreSQL with the PostGIS spatial extension, and it is
the system of record for everything an instance can't regenerate from source
data. User accounts and sessions, admin and integration settings, the audit log,
saved places, imported GTFS schedules, and the rows the data-manager's POI ingest
pipeline writes all live here. `app-api`, `data-manager`, and `martin` (when the
tile stack is enabled) all connect to it over the private Docker network.

| Property | Value |
| --- | --- |
| Image | `postgis/postgis:18-3.6` (PostgreSQL 18, PostGIS 3.6) |
| Database / user | `openmapx` / `postgres` |
| Memory limit | `2g` |
| Volume | `openmapx-pgdata` at `/var/lib/postgresql` (backed up) |
| Internal address | `postgis:5432` |
| Host binding | `127.0.0.1:5432` (loopback only) |

Other containers reach the database by service name — `app-api`, for instance, is
handed `postgresql://postgres:${POSTGRES_PASSWORD}@postgis:5432/openmapx`. The
host port is published on loopback only, so you can run `psql` from the host but
nothing outside the machine can connect.

### The password

`POSTGRES_PASSWORD` is the one secret PostGIS can't start without. The rendered
compose file writes it as `${POSTGRES_PASSWORD:?...}`, so Compose refuses to come
up if it's unset — production can't accidentally ship with the default. Generate
a strong value and put it in `infra/docker/.env`:

```bash
openssl rand -hex 32
```

The same value feeds the `DATABASE_URL` that `app-api` and `data-manager` use, so
there is nothing to keep in sync by hand — they all read it from the one
variable. See [Configuration](../install/configuration.md) for the full `.env`
reference.

:::caution[Rotating the password]
PostgreSQL only reads `POSTGRES_PASSWORD` when it first initializes an empty data
directory; once the volume holds a database, the password baked into the cluster
is authoritative and a later change to `.env` would normally be silently ignored.
OpenMapX works around this with an entrypoint wrapper that re-applies the password
from the environment on every start, so rotating the secret and recreating the
container actually takes effect. The healthcheck only reports healthy once that
sync has run, which is why dependents that wait on `service_healthy` never race a
stale password.
:::

### Sizing and tuning

The 2 GB memory limit is comfortable for the application workload — accounts,
settings, and POI rows stay well under 100 MB. GTFS imports are what grow the
database: a single feed runs from tens to a few hundred megabytes, and a
country- or planet-scale transit deployment with hundreds of feeds can reach tens
or hundreds of gigabytes on the `openmapx-pgdata` volume. Plan host disk
accordingly, and if you import many feeds, raise the limit by setting a per-service
override and re-rendering:

```bash
# infra/docker/.env
SERVICE_POSTGIS_MEMORY_LIMIT=4g
```

```bash
pnpm openmapx compose render
pnpm openmapx services recreate postgis
```

Schema migrations are automatic: `app-api` applies pending Drizzle migrations on
every boot, so a freshly initialized or freshly restored database is brought up to
the running code's schema with no manual SQL.

### Backups

The `openmapx-pgdata` volume is flagged for backup, and it is the centerpiece of
every snapshot — the backup tooling captures it with a streamed `pg_dump` while
the database keeps running. Restores drop and replay the dump through `psql`.
Because the dump is what's irreplaceable, treat the database backup as the thing
you must not lose. The full workflow, including the caveat that `.env` (and with
it `POSTGRES_PASSWORD`) is **not** part of a snapshot, is in
[Backup & restore](../administration/backup-and-restore.md).

## Valkey — the cache

The `redis` service runs [Valkey](https://valkey.io/) 8, the open-source,
Redis-compatible fork maintained under the Linux Foundation. It speaks the Redis
wire protocol exactly, so `app-api` connects with an ordinary Redis client at
`redis://redis:6379` and `redis-cli` works unchanged. The service id stays
`redis` for compatibility even though the image is Valkey.

| Property | Value |
| --- | --- |
| Image | `valkey/valkey:8-alpine` |
| Memory limit | `512m` |
| Volume | `openmapx-redisdata` at `/data` (backed up) |
| Internal address | `redis:6379` |
| Host binding | `127.0.0.1:6379` (loopback only) |

Everything in the cache is derived from somewhere else and carries a time-to-live,
so it expires and repopulates on its own. `app-api` caches upstream provider
responses here — geocoding and transit results, weather and air-quality readings,
photo lookups, per-integration namespaced entries, and integration health — and
the dynamic transit registry it fetches from GitHub is stored under
`transit:registry` with a 48-hour TTL. The data-manager's POI ingest pipeline
also writes live POI state here for `app-api` to read back.

512 MB is generous for this; real usage is typically well under half that, since
entries expire rather than accumulate. The `openmapx-redisdata` volume is flagged
for backup and captured in snapshots, but because the contents are reconstructible,
losing the cache only costs a brief warm-up of cold requests — never information.
If a release changes how something is serialized and you see stale shapes, it's
safe to flush:

```bash
docker compose -f infra/docker/docker-compose.generated.yml exec redis redis-cli flushall
```

The cache refills from upstream on the next request.

## Traefik — the reverse proxy

The `traefik` service is the front door. It terminates TLS, redirects HTTP to
HTTPS, obtains and renews Let's Encrypt certificates automatically, and routes
each request to the right container by hostname and path. It is the **only**
service published to the public internet — everything else binds to loopback or
stays on the private network.

| Property | Value |
| --- | --- |
| Image | `traefik:v3.6` |
| Memory limit | `256m` |
| Volume | `openmapx-traefik-acme` at `/etc/traefik` (backed up — holds the certificates) |
| Published ports | TCP `80`, TCP `443`, UDP `443` (HTTP/3 / QUIC) |

Traefik mounts the Docker socket read-only and discovers services through it. Its
static config (`services/traefik/config/traefik.yml`) defines two entry points:
`web` on port 80, which redirects everything to HTTPS, and `websecure` on port
443, which terminates TLS using the `letsencrypt` certificate resolver. UDP/443
carries HTTP/3.

### TLS and the two variables that drive it

Two `.env` values configure the public surface:

- **`DOMAIN`** — your public hostname. The renderer bakes it into every routing
  rule, so a service is reachable at `https://${DOMAIN}/<its-prefix>`. Point both
  an A and an AAAA record at the host.
- **`ACME_EMAIL`** — the contact address Traefik registers with Let's Encrypt.
  It's injected into the container as
  `TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL` and receives expiry
  notices.

Certificates are obtained via the Let's Encrypt HTTP challenge, which means your
domain must resolve to the host and inbound port 80 must be open — that's how the
challenge is answered before the redirect to HTTPS takes over. Issued
certificates are written to `acme.json` inside the `openmapx-traefik-acme` volume
and renewed automatically ahead of expiry; the volume is backed up so a restore
brings the certificates back with it. There is nothing to run by hand.

:::note[Default exposure]
A fresh deployment serves the stack publicly. The static config ships a
commented-out basic-auth hook (`dynamic/auth.yml.example`) you can enable to gate
the whole site behind a username and password while you set things up; without it,
anything routed is reachable by anyone who can resolve your domain. Plan your
exposure before pointing DNS at the host.
:::

### Label-driven routing

There is no hand-maintained route table. Traefik runs with
`exposedByDefault: false`, so a container is invisible to it until the renderer
emits routing labels — and the renderer emits those only for a service whose
manifest opts in with an `exposure.proxy` block. From a manifest like:

```json
{
  "exposure": {
    "proxy": {
      "enabled": true,
      "pathPrefix": "/tiles",
      "stripPrefix": true
    }
  }
}
```

the renderer generates the equivalent Traefik labels — a `Host` + `PathPrefix`
rule against `DOMAIN`, the `websecure` entry point, the `letsencrypt` resolver,
the backend port, and (here) a `stripprefix` middleware. The result is that the
tile server answers at `https://${DOMAIN}/tiles/`, with the `/tiles` prefix
stripped before the request reaches it. A service with no `pathPrefix` — the web
app — gets the catch-all rule at the lowest priority, so it handles every path no
more specific rule claimed. The core layout that ships today:

| Path | Service |
| --- | --- |
| `/api/*` | `app-api` |
| `/.well-known/*` | `well-known` |
| `/tiles/*` | `tileserver` (prefix stripped) |
| `/martin/*` | `martin` (prefix stripped) |
| `/*` | `app-web` (catch-all, lowest priority) |

Because routes come from manifests, exposing a service is a render-time decision,
not a Traefik edit: add the `exposure.proxy` block, re-render, and the labels
appear. The mechanics — and the alternative host-port binding for non-HTTP
services — are covered in [Managing services](../install/managing-services.md)
under exposure, with the field-level reference in the
[service manifest](../developer/service-manifest.md) docs.

Traefik watches the Docker socket live, so label changes from a re-render and a
recreate take effect without restarting the proxy. After editing a manifest:

```bash
pnpm openmapx compose render
pnpm openmapx services start <service>
```

## Where to go next

- **[Managing services](../install/managing-services.md)** — selecting the core,
  rendering the stack, and the full exposure model.
- **[Configuration](../install/configuration.md)** — `DOMAIN`, `ACME_EMAIL`,
  `POSTGRES_PASSWORD`, and the rest of `infra/docker/.env`.
- **[Backup & restore](../administration/backup-and-restore.md)** — snapshotting
  the database, the cache, and the ACME certificates.
- **[Requirements](../install/requirements.md)** — host sizing, including disk for
  the database volume.
- **[Service manifest](../developer/service-manifest.md)** — the `exposure`,
  `volumes`, and `container` fields these services are built from.
