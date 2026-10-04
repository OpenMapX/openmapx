---
title: Configuration
description: Reference for the environment variables an OpenMapX deployment reads from infra/docker/.env, with required values, defaults, and how to generate each secret.
sidebar_position: 3
---

# Configuration

A Docker deployment of OpenMapX reads **one** environment file:
`infra/docker/.env`. Copy it from the tracked template and fill in the handful
of required values:

```bash
cp infra/docker/.env.example infra/docker/.env
```

Both Docker Compose and the `openmapx` CLI auto-load this file from the
directory containing the generated compose file, so you set a value once and
both sides see it. At `docker compose up` time, Compose substitutes the values
into the `${VAR}` placeholders in the rendered YAML, and the service manifests
forward the resolved values into each container's environment.

A few conventions are worth knowing before the tables:

- **Required values fail loud.** The most critical keys are written into the
  generated stack as `${VAR:?error}` — Compose refuses to start if they are
  unset, so production can't silently ship with a placeholder. They are marked
  **Required** below.
- **`.env.example` is the source of truth.** Nearly every key documented here
  exists in that file, usually with an inline comment and a default (a few
  provider-level `INTEGRATION_*` overrides are documented for completeness even
  when the template omits them). When in doubt, read the template.
- **Most feature credentials live in the admin UI, not here.** API keys for
  individual integrations (tile providers, transit feeds, weather, fuel prices,
  and so on) are managed at `/admin/integrations`. Anything you _do_ set in
  `.env` always wins over an admin-stored value. See
  [How it works](../overview/how-it-works.md) for the service/integration model.

:::caution[Apply configuration after editing]
Changing `.env` only takes effect after applying the affected services. Re-run
`docker compose up -d` (Compose detects the changed file and replaces what's
needed) or use `pnpm openmapx services start <service>`.
:::

## Core / required

The values without which the stack won't start. Generate the secrets — never
ship the placeholders.

| Variable            | Description                                                                                                                                                                                                                                                                                                                                                                   | Required / Default          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `DOMAIN`            | Public domain. Drives Traefik routing, the auth URLs (`BETTER_AUTH_URL`, `PASSKEY_RP_ID`, `PASSKEY_ORIGIN`), the web app's `NEXT_PUBLIC_API_URL`, tile-server URLs, and the outbound contact identity (the contact address in third-party User-Agent strings and the email `From` fallback). Point both an A and an AAAA record at the host.                                  | Default `localhost`         |
| `ACME_EMAIL`        | Contact email for Traefik's automatic Let's Encrypt TLS certificates.                                                                                                                                                                                                                                                                                                         | Default `admin@example.com` |
| `POSTGRES_PASSWORD` | Unique password for the PostgreSQL/PostGIS database (used by `postgis`, `app-api`, and `data-manager`). Generate it before the first render with `openssl rand -hex 32`; it must be at least 24 characters and must not be a known placeholder or match `POSTGRES_USER`.                                                                                                      | **Required**                |
| `OPENMAPX_HOST_DIR` | Absolute host path of the OpenMapX repo checkout. The `ops-agent` container shells out to `docker compose` and mounts this path at the same path inside the container, so generated bind sources like `./data` resolve correctly. Find it with `pwd` from the repo root.                                                                                                      | **Required** (no default)   |
| `DOCKER_GID`        | The host's docker-socket group id. The `ops-agent` container mounts the Docker socket (`/var/run/docker.sock`) as a non-root user and must join this group, or host container lifecycle operations fail with "permission denied". Host-specific — find it with `stat -c %g /var/run/docker.sock`. Compose has no fallback, so it must be set; `.env.example` pre-fills `999`. | **Required**                |

:::note[Domain and TLS networking]
Traefik serves HTTP/3 (QUIC) on UDP/443 and the OpenMapX Docker network is
dual-stack. For IPv6 to reach published ports, the Docker daemon needs
`ip6tables` enabled — the default in Docker Engine 27+, otherwise add
`{"experimental": true, "ip6tables": true}` to `/etc/docker/daemon.json` and
restart the daemon.
:::

:::caution[Compose's required-variable check is not a strength check]
The `${VAR:?required}` syntax rejects an unset or empty value only. It does not
recognize a public example value, a username reused as a password, or a weak
short value. `openmapx compose render`, service start, and `openmapx check`
apply the stronger deployment policy before invoking Docker. Production
database bootstraps repeat the database check, while the API and data-manager
repeat the checks for their respective application secrets, so direct Compose
use cannot bypass the policy. Errors report only the policy reason, never the
credential or full database URL.
:::

## Secrets

Authentication and internal service secrets. `BETTER_AUTH_SECRET` and
`DATA_MANAGER_AUTH_TOKEN` must each contain at least 32 characters in production;
the CLI validates both before deployment and their services validate them again
at startup. Generate each with the command shown.

| Variable                     | Description                                                                                                                                                                                                                                                                                                                                                          | Required / Default                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `BETTER_AUTH_SECRET`         | Better Auth session-signing key. No fallback — the API refuses to start without it and rejects production values shorter than 32 characters. Generate with `npx @better-auth/cli@latest secret`.                                                                                                                                                                     | **Required**                           |
| `OPENMAPX_SECRETS_KEY`       | Symmetric key (32 bytes, hex — 64 chars) used to encrypt integration secrets stored in the vault. If unset, integrations that store secrets in the admin panel won't decrypt after a restart. Generate with `openssl rand -hex 32`.                                                                                                                                  | **Required** (to use the secret vault) |
| `DATA_MANAGER_AUTH_TOKEN`    | Shared secret between `app-api` and the `data-manager` service; every data-manager mutation endpoint (downloads, hardlinks, dataset reload, conversions) requires it. Production rejects values shorter than 32 characters; development generates a random ephemeral token when unset. Generate with `openssl rand -hex 32`.                                         | **Required** in production             |
| `OPENMAPX_LOCAL_ADMIN_TOKEN` | Shared secret for the CLI ↔ API loopback admin short-circuit. When set, loopback requests only gain admin if they carry a matching `X-OpenMapX-Local-Admin` header (a CSRF guard); the CLI attaches it automatically. In production with no token, the loopback bypass is denied and the CLI needs a web-login session cookie. Generate with `openssl rand -hex 32`. | Optional (recommended). Default unset  |

## Docker & host wiring

How the containers find the host, the repo, and bind-mounted volumes. The
required pieces of this group are listed under [Core / required](#core--required)
(`OPENMAPX_HOST_DIR`, `DOCKER_GID`); the rest are optional.

| Variable                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Required / Default                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `OPENMAPX_CUSTOM_INTEGRATIONS_DIR` | Container path where community integrations (installed by the admin panel or CLI) are mounted. Leave at the default unless you also change the `app-api` bind-mount target.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Default `/app/custom_integrations`                                                    |
| `UID`                              | Host UID for bind-mounted volumes (Linux). macOS/Windows usually don't need this — Docker Desktop handles ownership.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Optional. Commented `1000`                                                            |
| `GID`                              | Host GID for bind-mounted volumes (Linux). Same caveat as `UID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Optional. Commented `1000`                                                            |
| `DATA_MANAGER_URL`                 | Base URL `app-api` uses to reach the data-manager. Compose overrides this to the service-network DNS name automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Default `http://localhost:4000` (`pnpm dev`); compose sets `http://data-manager:4000` |
| `DATA_MANAGER_PLAINTEXT_HOSTS`     | Comma-separated hostnames that may be reached over plain `http://` in addition to `localhost`, `127.0.0.1`, `::1` and `data-manager`. `DATA_MANAGER_URL` must otherwise be `https://`; credentials, path prefixes and query strings are always rejected.                                                                                                                                                                                                                                                                                                                                                               | Unset                                                                                 |
| `OPENMAPX_FETCH_JSON_MAX_BYTES`    | Ceiling in bytes for upstream JSON responses fetched by integrations that do not set their own limit. Lower it to tighten memory use, or raise it for a large regional feed; a raised value is logged once at first use.                                                                                                                                                                                                                                                                                                                                                                                               | 8 MiB                                                                                 |
| `OPENMAPX_RELEASE_MANIFEST_IMAGE`  | Release-manifest image the admin updater and `pnpm openmapx compose release` resolve. Forks or mirrored registries point it at their own `<registry>/<namespace>/release-manifest[:tag]`; every pinned image must then live under that `<registry>/<namespace>` and carry a digest. An **empty** value disables release resolution for local-image workflows. Existing release overlays remain active; deliberately remove the overlay when leaving the release channel. With no overlay, `services update` of core apps pulls their maintained `latest` tags. This does not disable application-image registry pulls. | `ghcr.io/openmapx/release-manifest:latest`                                            |
| `OPENMAPX_ENABLED_SERVICES`        | Pin a specific service selection (comma- or space-separated) for CI/repeatable deploys. Wins over the `service-selection.json` written by the admin UI / CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Optional. Default: `service-selection.json`                                           |
| `OPENMAPX_DOCKER_CONFIG_DIR`       | Host directory holding Docker registry credentials, mounted into `ops-agent` at `/home/node/.docker` so the extension store's **Update** and `compose pull` can authenticate against private container registries (such as private GHCR images). On the reference deploy this is `/home/ubuntu/.docker`.                                                                                                                                                                                                                                                                                                               | Optional. Default unset                                                               |
| `OPENMAPX_PROXY_NETWORK`           | Docker network of a reverse proxy the host already runs (a Traefik with the Docker provider that owns ports 80/443). When set, the bundled `traefik` service is never selected, every routed service also joins this network, and its labels name it as the network to route over. See [Behind an existing reverse proxy](./managing-services.md#behind-an-existing-reverse-proxy).                                                                                                                                                                                                                                    | Optional. Default unset (bundled Traefik)                                             |
| `OPENMAPX_PROXY_ENTRYPOINT`        | Entrypoint the routed services' Traefik labels use. Only an operator-run proxy reads the labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Default `websecure`                                                                   |
| `OPENMAPX_PROXY_CERT_RESOLVER`     | Certificate resolver the routed services' Traefik labels use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Default `letsencrypt`                                                                 |
| `<SERVICE>_HOST_PORT`              | Moves a service's published loopback port when the host already uses it, e.g. `DATA_MANAGER_HOST_PORT=14000`. A service that publishes several container ports takes `<SERVICE>_HOST_PORT_<CONTAINER_PORT>`. The CLI reaches the data-manager on `DATA_MANAGER_HOST_PORT`; move it there rather than setting `DATA_MANAGER_URL`, which `app-api` also reads.                                                                                                                                                                                                                                                           | Optional. Default: the manifest's port                                                |

## Authentication & OAuth

Optional social-login providers. Each requires an OAuth app registered with the
provider.

| Variable                  | Description                                                                                                                                                             | Required / Default  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `OSM_CLIENT_ID`           | OpenStreetMap OAuth client id. Register at the [OSM OAuth applications page](https://www.openstreetmap.org/oauth2/applications).                                        | Optional. Commented |
| `OSM_CLIENT_SECRET`       | OpenStreetMap OAuth client secret.                                                                                                                                      | Optional. Commented |
| `MAPILLARY_CLIENT_ID`     | Mapillary OAuth client id (re-uses the same app as `MAPILLARY_TOKEN`). Register at the [Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers). | Optional. Commented |
| `MAPILLARY_CLIENT_SECRET` | Mapillary OAuth client secret.                                                                                                                                          | Optional. Commented |

## OpenStreetMap contributions

Lets a signed-in person publish a curated correction to an **existing**
OpenStreetMap element, or a public OSM note, using their own linked account. See
the [feature overview](../features/osm-contributions.md) and the
[developer notes](../developer/osm-contributions.md).

Both flags default to **off**. Nothing is written to OpenStreetMap until an
operator turns them on deliberately.

| Variable                                                 | Description                                                                                                           | Required / Default                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `OSM_CONTRIBUTIONS_ENABLED`                              | Master flag. Controls whether the UI is discoverable and the contribution routes answer.                              | Optional. `false`                                                          |
| `OSM_DIRECT_EDITING_ENABLED`                             | Independent kill switch for element writes. Turning it off does **not** convert a requested edit into a note.         | Optional. `false`                                                          |
| `OSM_API_URL`                                            | OpenStreetMap API origin.                                                                                             | Optional. `https://api.openstreetmap.org`                                  |
| `OSM_WEB_URL`                                            | OpenStreetMap website origin (element, changeset, note and editor links).                                             | Optional. `https://www.openstreetmap.org`                                  |
| `OSM_DISCOVERY_URL`                                      | OpenID discovery document used for authorization.                                                                     | Optional. `https://www.openstreetmap.org/.well-known/openid-configuration` |
| `OPENMAPX_VERSION`                                       | Value reported in each changeset's `created_by` tag, as `OpenMapX <version>`. 1–64 characters from `[A-Za-z0-9._+-]`. | Optional. `1.0`                                                            |
| `RATE_LIMIT_OSM_CONTRIBUTION_READ_MAX` / `_WINDOW_MS`    | Per-user capability/context/category reads.                                                                           | Optional. `60` / `600000`                                                  |
| `RATE_LIMIT_OSM_CONTRIBUTION_PREVIEW_MAX` / `_WINDOW_MS` | Per-user previews.                                                                                                    | Optional. `30` / `600000`                                                  |
| `RATE_LIMIT_OSM_CONTRIBUTION_PUBLISH_MAX` / `_WINDOW_MS` | Per-user direct publishes.                                                                                            | Optional. `10` / `600000`                                                  |
| `RATE_LIMIT_OSM_CONTRIBUTION_NOTE_MAX` / `_WINDOW_MS`    | Per-user note creations.                                                                                              | Optional. `5` / `600000`                                                   |

### Registering the OAuth application

Contributions reuse the same OAuth app as OpenStreetMap sign-in
(`OSM_CLIENT_ID` / `OSM_CLIENT_SECRET`). Without **both** credentials the
feature reports itself disabled even if the flags are on — it fails closed.

Register the redirect URL exactly as Better Auth's generic-OAuth route expects:

```text
<BETTER_AUTH_URL>/api/auth/oauth2/callback/openstreetmap
```

For a standalone local API dev setup (`pnpm dev`) that is:

```text
http://127.0.0.1:3001/api/auth/oauth2/callback/openstreetmap
```

In Docker Compose, port 3001 has no direct host port binding; external traffic
routes through Traefik, so use your public domain (or localhost when running
without TLS):

```text
https://<DOMAIN>/api/auth/oauth2/callback/openstreetmap
```

Ordinary sign-in requests only `openid read_prefs`. The write permissions
(`write_api`, `write_notes`) are requested incrementally, the first time someone
actually contributes.

### Testing against the OpenStreetMap development API

The development instance is a **separate** OpenStreetMap deployment: it needs
its own OAuth application and its own test accounts, and those accounts must
accept that instance's Contributor Terms separately.

Change all three origins together:

```dotenv
OSM_API_URL=https://master.apis.dev.openstreetmap.org
OSM_WEB_URL=https://master.apis.dev.openstreetmap.org
OSM_DISCOVERY_URL=https://master.apis.dev.openstreetmap.org/.well-known/openid-configuration
```

Setting only `OSM_API_URL` while leaving the production website and discovery
URLs is **invalid** and rejected at startup — it would mix production identity
with development data. The API also refuses credentials, query strings,
fragments and non-HTTP(S) schemes in any of the three.

Never point a deployment that has the flags on at production OpenStreetMap for
testing.

### Public feature discovery

The public `/api/capabilities` response carries a single bounded bit,
`features.osmContributions`, which is true only when the master flag **and**
OAuth configuration are set. It never exposes the direct-write kill switch or
anyone's linked-account state.

### Token storage and the auth secret

Provider OAuth tokens are **encrypted at rest** using the deployment's
`BETTER_AUTH_SECRET`. Keep that secret protected and stable: rotating it
intentionally makes existing stored tokens undecryptable, and affected users
must re-link their OpenStreetMap (or other OAuth) account. See
[upgrading](./upgrading.md#openstreetmap-contributions-and-oauth-token-encryption)
for what happens to tokens stored before encryption was enabled.

### Redis

Redis is recommended but not required. It backs the short submission lock and
the idempotency record. Without it, a bounded in-memory fallback is used, which
is correct for a single instance. Contribution safety does not depend on Redis
in either case — OpenStreetMap's exact element version is the real guard.

## Map style & tiles

Tile-source selection and keys. The `NEXT_PUBLIC_*` values (except
`NEXT_PUBLIC_API_URL`) are read per-request via the web app's `EnvProvider`, so
runtime changes reach both server and client components without a rebuild.

The default map style is the bundled OpenMapX style. If self-hosted tile URLs
are not configured, its vector tiles and glyphs use the MapTiler fallback
through the API routes. Set `NEXT_PUBLIC_TILES_URL` and
`NEXT_PUBLIC_MAP_STYLE_URL` to run the base map fully on your own tile stack.

| Variable                                    | Description                                                                                                                                                                                                                             | Required / Default  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `NEXT_PUBLIC_STYLE_PROVIDER`                | Selects the base style. `openmapx` (default) loads the bundled OpenMapX style. `maptiler` loads the MapTiler-compatible style loader, using the self-hosted style when `NEXT_PUBLIC_MAP_STYLE_URL` is set and MapTiler Cloud otherwise. | Default `openmapx`  |
| `MAPTILER_KEY`                              | MapTiler Cloud API key for the hosted style/tile fallback and MapTiler layers. Also settable in `/admin/settings → Map`. Leave commented to manage from the admin UI; uncomment to lock a value (env wins).                             | Optional. Commented |
| `NEXT_PUBLIC_MAP_STYLE_URL`                 | Base URL of the self-hosted `tileserver-gl`. With `maptiler`, the web app appends `/styles/<style>/style.json`; with `openmapx`, it uses `/fonts` for glyphs. With the built-in Traefik route this is `${DOMAIN}/tiles`.                | Optional. Commented |
| `NEXT_PUBLIC_TILES_URL`                     | Self-hosted TileJSON URL used as the vector source by the OpenMapX style. If omitted, the style uses the MapTiler fallback.                                                                                                             | Optional. Commented |
| `NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE`     | Override URL template for the traffic raster layer.                                                                                                                                                                                     | Optional. Commented |
| `NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE`     | Override URL template for the CyclOSM layer.                                                                                                                                                                                            | Optional. Commented |
| `NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL`      | Override DEM TileJSON URL. Defaults to proxied Mapterhorn for self-hosted OpenMapX tiles, or proxied MapTiler otherwise.                                                                                                                | Optional. Commented |
| `NEXT_PUBLIC_TERRAIN_DEM_TILE_URL_TEMPLATE` | Optional `{z}/{x}/{y}` tile URL for browser-generated contours from a custom DEM. Otherwise, read from TileJSON. Use a local URL to keep tile requests on your own origin.                                                              | Optional. Commented |
| `NEXT_PUBLIC_TERRAIN_DEM_ENCODING`          | Custom DEM encoding: `mapbox` (default) or `terrarium`.                                                                                                                                                                                 | Optional. Commented |
| `NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL`  | Optional vector contour TileJSON with MapTiler-compatible `contour` lines; overrides generated contours.                                                                                                                                | Optional. Commented |
| `NEXT_PUBLIC_TERRAIN_ATTRIBUTION_NAME`      | Visible terrain-data provider credit; defaults to `© Mapterhorn` for self-hosted OpenMapX tiles or `© MapTiler` otherwise.                                                                                                              | Optional. Commented |
| `NEXT_PUBLIC_TERRAIN_ATTRIBUTION_URL`       | URL for the terrain-data provider credit. Defaults to the corresponding provider's attribution page.                                                                                                                                    | Optional. Commented |

## Street-level imagery

Mapillary uses a server-side access token. Coverage, metadata, and panorama
assets are proxied, so the token is never shipped in the browser bundle.

| Variable          | Description                                                                                                                                                                                                                                              | Required / Default      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `MAPILLARY_TOKEN` | Server-side Mapillary token used by the `/api/mapillary/*` vector-tile proxy and integrations that fetch Mapillary on the user's behalf. Stays server-side — street-level imagery is proxied through the API, so no Mapillary token reaches the browser. | Optional. Default unset |

## Backend endpoint overrides

Self-hosted backends are normally resolved from the service registry. These
overrides force a specific (often public) endpoint instead — useful when a
backend runs outside the Compose stack. All optional and commented by default.

| Variable                            | Description                                                                                                                                                                                                                                                                                                                                                                      | Required / Default                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `INTEGRATION_ROUTING_OSRM_ENDPOINT` | OSRM endpoint for the routing provider (car routing). Usually unset — a co-deployed `osrm` service is auto-resolved over the internal network.                                                                                                                                                                                                                                   | Optional. Default unset                          |
| `OSRM_URL`                          | OSRM endpoint used by the `app-api` road-snap helper (distinct from the routing provider above). Usually unset — the co-deployed `osrm` service is used.                                                                                                                                                                                                                         | Optional. Default unset                          |
| `VALHALLA_URL`                      | Valhalla endpoint for isochrones, elevation, and road-snap (bus). The default targets Stadia Maps' hosted Valhalla, which requires `VALHALLA_API_KEY`; a self-hosted Valhalla needs no key. The routing/directions **provider** resolves separately — via the co-deployed `valhalla` service or `INTEGRATION_ROUTING_VALHALLA_ENDPOINT` / `INTEGRATION_ROUTING_VALHALLA_APIKEY`. | Optional. Commented `https://api.stadiamaps.com` |
| `VALHALLA_API_KEY`                  | API key for the hosted Valhalla above (free non-commercial tier at [stadiamaps.com](https://stadiamaps.com/)). Leave blank for a self-hosted Valhalla.                                                                                                                                                                                                                           | Optional. Default unset                          |
| `MOTIS_URL`                         | MOTIS endpoint for the transit manager and shared local MOTIS helpers. Over the internal network MOTIS listens on `8080` (`8081` is only the host-loopback mapping).                                                                                                                                                                                                             | Optional. Commented `http://motis:8080`          |
| `OVERPASS_URL`                      | Overpass API base URL (no path) for the core Overpass client (POI fallbacks, navigation alerts, junction-view gantry lookups). The OpenConditions ingest service has its own setting, `SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL`. Multi-user deployments should use the self-hosted `overpass`.                                                                                | Optional. Commented `http://overpass:80`         |
| `NOMINATIM_URL`                     | Nominatim endpoint for station reverse-geocoding (bike / scooter / car sharing).                                                                                                                                                                                                                                                                                                 | Optional. Commented `http://nominatim:8080`      |
| `TRANSITOUS_URL`                    | Transitous endpoint for rental POIs used by shared-mobility integrations.                                                                                                                                                                                                                                                                                                        | Optional. Commented `https://api.transitous.org` |

## Regional defaults

Default regions and country filters used by the CLI and selected services, so
you can keep them here instead of repeating CLI flags. A region passed on the
command line overrides the env value for that invocation.

| Variable                         | Description                                                                                                                                                                                                                                              | Required / Default                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `OPENMAPX_REGION`                | Shared default OSM region for selectors like `openmapx data download osm`, `services build`, and `data convert overpass`.                                                                                                                                | Optional. Commented `europe/germany` |
| `OSRM_REGION`                    | Per-service OSRM build region (wins over `OPENMAPX_REGION` for that target).                                                                                                                                                                             | Optional. Commented                  |
| `OTP_REGION`                     | Per-service OTP build region.                                                                                                                                                                                                                            | Optional. Commented                  |
| `MOTIS_REGION`                   | Per-service MOTIS build region.                                                                                                                                                                                                                          | Optional. Commented `planet`         |
| `PELIAS_REGION`                  | Per-service Pelias build region.                                                                                                                                                                                                                         | Optional. Commented                  |
| `TILESERVER_REGION`              | Per-service TileServer GL build region.                                                                                                                                                                                                                  | Optional. Commented                  |
| `OVERPASS_REGION`                | Per-service Overpass build region.                                                                                                                                                                                                                       | Optional. Commented                  |
| `PLANETILER_JAVA_TOOL_OPTIONS`   | JVM options for the TileServer MBTiles build, e.g. `-Xmx8g`. The default heap is half the input PBF (at least 2 GB), or `-Xmx30g` for the planet.                                                                                                        | Optional. Commented                  |
| `PLANETILER_WORK_DIR`            | Host directory for Planetiler's downloaded sources and temp files. Its temp files run to several times the PBF, so point it at a disk with room.                                                                                                         | Optional. Default `data/planetiler`  |
| `OTP_BUILD_JAVA_TOOL_OPTIONS`    | JVM options for the OTP graph build (not the runtime container).                                                                                                                                                                                         | Optional. Default `-Xmx24g`          |
| `TRANSITOUS_COUNTRIES`           | Country filter (e.g. `de,at,ch`) for `data sync` and MOTIS Transitous config generation. With the default `regional-assisted` profile the data-manager refuses to start without it (or `MOTIS_FEED_ALLOW_LIST`), even when no transit engine is enabled. | **Required** for regional profiles   |
| `INTEGRATION_GEOCODING_PROVIDER` | Comma-separated geocoding fallback chain, tried left to right. Valid names: `maptiler`, `photon`, `nominatim`, `pelias`, `motis`, `transitous`, `entur`, `db-ris`.                                                                                       | Optional. Default `maptiler`         |
| `PHOTON_REGION`                  | Runtime download region for the self-hosted Photon index.                                                                                                                                                                                                | Default `planet`                     |

## Service tuning

Knobs forwarded into the backend containers. Defaults are sensible for most
deployments.

| Variable                                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Required / Default                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `NOMINATIM_THREADS`                                | Import/query thread count for the self-hosted Nominatim geocoder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Default `8`                                                 |
| `NOMINATIM_IMPORT_WIKIPEDIA`                       | Import Wikipedia importance scores during the Nominatim build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Default `true`                                              |
| `NOMINATIM_IMPORT_GB_POSTCODES`                    | Import GB postcodes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Default `false`                                             |
| `NOMINATIM_IMPORT_US_POSTCODES`                    | Import US postcodes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Default `false`                                             |
| `OVERPASS_SPACE`                                   | Overpass database space limit, in bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Default `107374182400` (~100 GiB)                           |
| `OVERPASS_FASTCGI_PROCESSES`                       | Number of Overpass FastCGI worker processes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Default `4`                                                 |
| `OVERPASS_DIFF_URL`                                | Replication feed Overpass applies daily. The default suits a planet import; a regional import must follow its extract's own feed (for Germany `https://download.geofabrik.de/europe/germany-updates/`), or the planet diffs pull changes from everywhere into the regional database.                                                                                                                                                                                                                                                                                                                                                                                          | Default `https://planet.openstreetmap.org/replication/day/` |
| `MOTIS_OPERATIONS_PROFILE`                         | Transit operations profile (`regional-assisted`, `regional-sovereign`, `planet`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Default `regional-assisted`                                 |
| `MOTIS_FREE_DISK_BYTES`                            | Minimum free disk space in bytes required before MOTIS import proceeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Optional. Default unset                                     |
| `MOTIS_IMPORT_TIMEOUT_MS`                          | Timeout for MOTIS initial import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Default `1800000` (30 min)                                  |
| `MOTIS_PROMOTE_RESTART_TIMEOUT_MS`                 | Timeout for promoted MOTIS restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Default `3600000` (1 hr)                                    |
| `MOTIS_PROMOTE_RESTART_POLL_INTERVAL_MS`           | Polling interval for promoted MOTIS restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Default `5000` ms                                           |
| `MOTIS_ROUTE_SHAPES`                               | Shape synthesis behavior (`missing` or `all`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Optional. Default unset                                     |
| `MOTIS_ELEVATORS_URL`                              | Station elevator live status feed URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Optional. Default unset                                     |
| `MOTIS_ELEVATORS_AUTH`                             | Authorization header/token for elevator feed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Optional. Default unset                                     |
| `MOTIS_OSR_FOOTPATH`                               | Footpath routing calculation on OpenStreetMap graphs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Default `true`                                              |
| `MOTIS_TILES`                                      | MOTIS internal vector tile rendering toggle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Optional. Default unset                                     |
| `MOTIS_INCREMENTAL_RT_UPDATE`                      | Toggle incremental real-time transit schedule updates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Optional. Default unset                                     |
| `VALHALLA_CONTAINER`                               | Docker container name for data-manager traffic extraction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Default `docker-valhalla-1`                                 |
| `TRAFFIC_VALHALLA_URL`                             | Valhalla endpoint data-manager traces road-condition spans against, to narrow a closure to the exact graph edges it covers. Must be the co-deployed Valhalla holding this deployment's traffic graph — deliberately separate from `VALHALLA_URL`, which may point at a hosted endpoint.                                                                                                                                                                                                                                                                                                                                                                                       | Default `http://valhalla:8002`                              |
| `OPENCONDITIONS_URL`                               | Base URL of the OpenConditions instance. The built-in `openconditions` integration in `app-api` reads road conditions and fuel stations from it; the data-manager reads live traffic (`/segments/speed.csv`, `/segments/conditions.json`). Unset: no OpenConditions and no traffic crons.                                                                                                                                                                                                                                                                                                                                                                                     | Optional. Default unset                                     |
| `OPENCONDITIONS_CONTRIBUTIONS_URL`                 | Base URL of the OpenConditions contributions API that `app-api` relays crowd reports to: `http://openconditions-contributions-api:4200` with the OpenConditions extension. Unset: `http://localhost:4200`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Optional. Default unset                                     |
| `OPENCONDITIONS_OPERATOR_TOKEN`                    | Bearer token `app-api` and the data-manager send for operator scope. The ingest service ignores this file: give its `OPENCONDITIONS_OPERATOR_TOKEN` credential the same value (32+ chars). Unset there, reads fall back to public scope; a different value fails every read with 401. Required for fuel in DE (Tankerkönig: redistribution not granted), AT (E-Control: no licence asserted) and OpenStreetMap stations (ODbL share-alike); in public scope the fuel layer shows France and Spain only. Read when the containers are created: after a change run `pnpm openmapx services start app-api data-manager` on the host (the admin panel never recreates `app-api`). | Required for DE/AT/OSM fuel. Default unset                  |
| `SERVICE_OPENCONDITIONS_INGEST_<KEY>`              | A setting of the OpenConditions ingest service, a community service that never sees the rest of this file (`SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL=http://overpass:80`). Wins over the admin config form. Apply with `pnpm openmapx services start openconditions-ingest`, which resets every setting saved only in the form to its default, so keep all of the service's settings here or all in the form. Admin Save & Apply never reads this file. Its database URL and operator token are vault credentials instead.                                                                                                                                                  | Optional. Manifest defaults                                 |
| `TRAFFIC_LIVE_CRON`                                | Cron schedule for the live-traffic cycle that writes speeds, speed caps and closures into `traffic.tar`. Set to `disabled`, `off` or `false` to turn the cycle off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Default `*/2 * * * *`                                       |
| `TRAFFIC_CONDITIONS_STALE_MS`                      | How long the last good conditions set is reused while `/segments/conditions.json` keeps failing. Past this age the closures are dropped and the router falls back to point-based exclusions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Default `600000` (10 min)                                   |
| `TRUST_PROXY_RANGES`                               | IP ranges trusted by Fastify for reverse-proxy headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Default `uniquelocal`                                       |
| `OPENMAPX_API_NODE_OPTIONS`                        | Node.js memory options for the `app-api` container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Default `--max-old-space-size=1536`                         |
| `RATE_LIMIT_IMAGE_PROXY_MAX_BYTES`                 | Per-client image-proxy byte budget over the configured window. Valid upstream `Content-Length` values reserve capacity early, but only bytes actually streamed remain charged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Default `134217728` (128 MiB)                               |
| `RATE_LIMIT_IMAGE_PROXY_WINDOW_MS`                 | Refill window for the per-client image-proxy byte budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Default `60000` (1 min)                                     |
| `RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_PER_CLIENT` | Maximum simultaneous image-proxy upstream streams for one network client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Default `16`                                                |
| `RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_GLOBAL`     | Maximum simultaneous image-proxy upstream streams in one API process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Default `64`                                                |

## Traffic & extra tile providers

Keys and overrides for the `app-api` traffic and tile proxies.

| Variable                                    | Description                                                                                                     | Required / Default                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `TRAFFIC_PROVIDER`                          | Traffic data provider.                                                                                          | Default `tomtom`                             |
| `TOMTOM_TRAFFIC_KEY`                        | TomTom Flow tile-proxy key. Sign up at [developer.tomtom.com](https://developer.tomtom.com/).                   | Optional. Default unset                      |
| `TOMTOM_TRAFFIC_URL`                        | TomTom API base URL.                                                                                            | Optional. Commented `https://api.tomtom.com` |
| `TOMTOM_TRAFFIC_VERSION`                    | TomTom Flow API version.                                                                                        | Optional. Commented `4`                      |
| `TOMTOM_TRAFFIC_STYLE`                      | TomTom Flow tile style.                                                                                         | Optional. Commented `relative-delay`         |
| `TOMTOM_TRAFFIC_TILE_SIZE`                  | TomTom tile size in pixels.                                                                                     | Optional. Commented `256`                    |
| `TOMTOM_TRAFFIC_THICKNESS`                  | TomTom Flow line thickness.                                                                                     | Optional. Commented `2`                      |
| `THUNDERFOREST_API_KEY`                     | Thunderforest OpenCycleMap key (free Hobby Project key at [thunderforest.com](https://www.thunderforest.com/)). | Optional. Default unset                      |
| `CYCLOSM_TILE_URL`                          | Override URL for the CyclOSM tile proxy.                                                                        | Optional. Commented                          |
| `WAYMARKED_CYCLING_TILE_URL`                | Override URL for the Waymarked Trails cycling layer.                                                            | Optional. Commented                          |
| `TRAFFIC_EXTRACT_CRON`                      | Cron schedule for extracting Valhalla traffic CSVs.                                                             | Default `0 5 * * *` (daily, 05:00 UTC)       |
| `NEXT_PUBLIC_TRAFFIC_MIN_ZOOM`              | Minimum zoom level where traffic overlays render in the frontend.                                               | Default `6`                                  |
| `INTEGRATION_STREET_LEVEL_IMAGERY_PROVIDER` | Preferred order for street-level imagery providers (`panoramax,mapillary`).                                     | Optional. Default unset                      |
| `OPENMAPTILES_FONTS_URL`                    | Custom source archive URL for downloading glyph font stacks.                                                    | Optional. Default upstream                   |

## Email

Used for email verification, 2FA, and email-change flows. The provider is
auto-detected by priority: **EmailLabs > Lettermint > SMTP**. These are also
settable in `/admin/settings → Email / SMTP`; env always wins.

| Variable                 | Description                                                                        | Required / Default          |
| ------------------------ | ---------------------------------------------------------------------------------- | --------------------------- |
| `EMAIL_FROM`             | Sender address, e.g. `OpenMapX <noreply@openmapx.example.com>`.                    | Optional. Commented         |
| `EMAILLABS_APP_KEY`      | EmailLabs app key ([emaillabs.io](https://emaillabs.io), 9k emails/mo free).       | Optional. Commented         |
| `EMAILLABS_SECRET_KEY`   | EmailLabs secret key.                                                              | Optional. Commented         |
| `EMAILLABS_SMTP_ACCOUNT` | EmailLabs SMTP account.                                                            | Optional. Commented         |
| `LETTERMINT_API_TOKEN`   | Lettermint API token ([lettermint.co](https://lettermint.co), 300 emails/mo free). | Optional. Commented         |
| `SMTP_HOST`              | SMTP server hostname (any provider).                                               | Optional. Commented         |
| `SMTP_PORT`              | SMTP port.                                                                         | Optional. Commented `587`   |
| `SMTP_SECURE`            | Use TLS on connect.                                                                | Optional. Commented `false` |
| `SMTP_USER`              | SMTP username.                                                                     | Optional. Commented         |
| `SMTP_PASS`              | SMTP password.                                                                     | Optional. Commented         |

## Transitous & cron

Schedules and tuning for the daily Transitous transit-data sync.

| Variable                                                                                  | Description                                                                                                                                                                                                                                                                                                                                                           | Required / Default                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `TRANSIT_SOURCE`                                                                          | How the Transitous dataset is obtained: `mirror` (default — download the prebuilt community bundle) or `build` (assemble it locally from feeds). See [Transit engines](../guides/transit-engines.md).                                                                                                                                                                 | Optional. Default `mirror`                        |
| `TRANSITOUS_ARTIFACT_BASE_URL`                                                            | Base URL the `mirror` mode pulls the prebuilt Transitous artifact from.                                                                                                                                                                                                                                                                                               | Optional. Default unset (upstream)                |
| `TRANSITOUS_API_KEYS_PATH`                                                                | Host/container path to Transitous secret API keys file for restricted feeds.                                                                                                                                                                                                                                                                                          | Default `/config/transitous/api-keys.json`        |
| `TRANSITOUS_FEEDS_OVERLAY_PATH`                                                           | Host/container path to feeds overlay configuration file.                                                                                                                                                                                                                                                                                                              | Optional. Default unset                           |
| `TRANSITOUS_SYNC_CRON`                                                                    | Cron schedule for the daily Transitous sync. Leaving it unset (or empty) uses the built-in `0 3 * * *`; set it to `disabled` (or `off`/`false`) to turn it off (e.g. on a staging host where you trigger manually).                                                                                                                                                   | Optional. Commented `0 3 * * *`                   |
| `TRANSITOUS_STALENESS_CHECK_CRON`                                                         | Cron schedule for the staleness sweep that flags feeds that have stopped updating. Set to `disabled` (or `off`/`false`) to turn it off.                                                                                                                                                                                                                               | Optional. Commented `0 4 * * *`                   |
| `TRANSITOUS_FEED_PROXY_RELOAD_CRON`                                                       | Cron schedule for the feed-proxy nginx-reload heartbeat — a safety net against a missed reload during sync.                                                                                                                                                                                                                                                           | Optional. Commented `*/15 * * * *`                |
| `TRANSITOUS_AUTO_BUMP_CRON`                                                               | Opt-in cron that advances the pinned Transitous catalog to upstream's latest behind the staging-slot canary — activates the new pin (and promotes) only if the candidate builds and passes the functional probes, otherwise keeps the current pin and alerts. **Unset/empty = disabled** (the pin stays frozen). See [Transit engines](../guides/transit-engines.md). | Optional. Default disabled                        |
| `TRANSITOUS_RUNNER_URL`                                                                   | Base URL of the private Transitous runner — the unprivileged container that executes the upstream catalog scripts. Compose wires this automatically; override it only if you run the runner elsewhere. Leaving it empty disables upstream script execution (the sync fails closed rather than running third-party Python inside the data manager).                    | Optional. Default `http://transitous-runner:4400` |
| `TRANSITOUS_ALERT_GH_TOKEN` / `TRANSITOUS_ALERT_GH_REPO`                                  | When both are set, sync/auto-bump failures and stale feeds open deduped GitHub issues instead of being log-only. Without them a canary rejection can silently freeze the live dataset for days.                                                                                                                                                                       | Optional. Default log-only                        |
| `MOTIS_RENTALS_WARMUP_MS` / `MOTIS_RENTALS_POLL_INTERVAL_MS`                              | How long the rentals canary re-polls MOTIS `/rentals` while it enumerates zero providers (GBFS warm-up after a restart) before failing, and the interval between polls.                                                                                                                                                                                               | Optional. Default `180000` / `5000`               |
| `MOTIS_HEALTH_BBOX_MIN_LAT` / `_MIN_LNG` / `_MAX_LAT` / `_MAX_LNG`                        | Bounding box coordinates used by MOTIS health checks to probe local data coverage.                                                                                                                                                                                                                                                                                    | Optional. Default unset                           |
| `MOTIS_HEALTH_PLAN_FROM_LAT` / `_FROM_LNG` / `_TO_LAT` / `_TO_LNG`                        | Endpoints for synthetic routing plan canary queries during health verification.                                                                                                                                                                                                                                                                                       | Optional. Default unset                           |
| `MOTIS_HEALTH_RENTAL_PROVIDER_IDS` / `_PLAN` / `_GROUPS` / `_PROVIDERS` / `_FORM_FACTORS` | Canaries validating rental provider and vehicle availability in live feeds.                                                                                                                                                                                                                                                                                           | Optional. Default unset                           |
| `MOTIS_GBFS_CATALOG_ENABLED`                                                              | Automatically discover and sync feeds from the upstream MobilityData GBFS catalog.                                                                                                                                                                                                                                                                                    | Optional. Default `false`                         |
| `MOTIS_GBFS_CATALOG_MAX_ADDITIONS`                                                        | Ceiling on new GBFS feeds added in a single sync run.                                                                                                                                                                                                                                                                                                                 | Default `50`                                      |
| `MOTIS_GBFS_CATALOG_CONCURRENCY`                                                          | Concurrent downloads when fetching GBFS catalog entries.                                                                                                                                                                                                                                                                                                              | Default `4`                                       |
| `MOTIS_GBFS_CATALOG_TIMEOUT_MS`                                                           | Per-feed probe timeout when testing GBFS discovery endpoints.                                                                                                                                                                                                                                                                                                         | Default `15000` (15s)                             |
| `MOTIS_GBFS_CATALOG_MAX_FAILURE_RATIO`                                                    | Maximum tolerated fraction of failed GBFS feeds before catalog update aborts.                                                                                                                                                                                                                                                                                         | Default `0.2` (20%)                               |

:::note[Transitous feed-proxy key]
The optional age private key used to decrypt `AGE-ENCRYPTED:` feed values has no
env variable. Drop the file at `infra/docker/secrets/transitous-feed-proxy.age`
on the host and re-render compose; the mount is omitted automatically when the
file is absent. See `infra/docker/secrets/README.md` for the generation steps.
:::

## Advanced & optional

Lower-level toggles, retention, and legal-page metadata. All optional.

| Variable                                                 | Description                                                                                                                                                                                        | Required / Default                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                                              | Fastify log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).                                                                                                                            | Optional. Commented `info`                                                                              |
| `OPENMAPX_DISABLE_LOCALHOST_AUTH`                        | Set to `1` to disable the loopback admin short-circuit entirely, regardless of `OPENMAPX_LOCAL_ADMIN_TOKEN`. Use on multi-tenant hosts where another local process could reach the API's loopback. | Optional. Commented                                                                                     |
| `ISOCHRONE_PROVIDER`                                     | Isochrone provider. Use `otp` to route isochrones through OpenTripPlanner instead of Valhalla.                                                                                                     | Optional. Commented. Default `valhalla`                                                                 |
| `AUDIT_LOG_RETENTION_DAYS`                               | Days to keep admin audit-log entries before the daily prune.                                                                                                                                       | Optional. Commented `90`                                                                                |
| `ADMIN_JOB_RETENTION_DAYS`                               | Days to keep finished admin jobs (in-flight jobs are never pruned).                                                                                                                                | Optional. Commented `30`                                                                                |
| `BACKUP_RETENTION_DAYS`                                  | Days to keep local backups. Expired backups are pruned and refused by restore; apply the same lifecycle to off-host copies.                                                                        | Optional. Default `30`                                                                                  |
| `GITHUB_TOKEN`                                           | GitHub API token — raises the Transitous catalog fetch rate limit from 60 to 5000 req/h. Needed only on multi-tenant hosts.                                                                        | Optional. Commented                                                                                     |
| `EXTENSION_CATALOG_URL`                                  | Default catalog URL for the **Extensions** store — the curated (verified-tier) list shown under `/admin/extensions`.                                                                               | Optional. Commented `https://raw.githubusercontent.com/openmapx/community-extensions/main/catalog.json` |
| `POI_INGEST_ALERT_GH_TOKEN` / `POI_INGEST_ALERT_GH_REPO` | When set, POI ingestion pipeline failures open GitHub issues in this repo.                                                                                                                         | Optional. Default unset                                                                                 |
| `POI_INGEST_STALENESS_CHECK_CRON`                        | Cron schedule for the POI source dataset staleness sweep.                                                                                                                                          | Default `30 4 * * *`                                                                                    |
| `OFFLINE_PACKAGE_WORKERS`                                | Concurrent worker jobs for offline map package preparation.                                                                                                                                        | Default `1`                                                                                             |
| `OFFLINE_PACKAGE_MAX_BYTES`                              | Maximum byte size for a single offline package archive.                                                                                                                                            | Default `5368709120` (5 GiB)                                                                            |
| `OFFLINE_PACKAGE_MAX_COUNT`                              | Maximum number of offline packages a single user may hold simultaneously.                                                                                                                          | Default `5`                                                                                             |
| `OFFLINE_PACKAGE_MAX_TOTAL_BYTES`                        | Maximum cumulative storage for all offline packages owned by one user.                                                                                                                             | Default `10737418240` (10 GiB)                                                                          |
| `OFFLINE_PACKAGE_MIN_FREE_BYTES`                         | Minimum host disk free space required to accept a new offline package build job.                                                                                                                   | Default `10737418240` (10 GiB)                                                                          |
| `LEGAL_NAME`                                             | Operator legal name shown on `/terms` and `/privacy`.                                                                                                                                              | Optional. Commented                                                                                     |
| `LEGAL_STREET`                                           | Operator street address.                                                                                                                                                                           | Optional. Commented                                                                                     |
| `LEGAL_POSTAL_CODE`                                      | Operator postal code.                                                                                                                                                                              | Optional. Commented                                                                                     |
| `LEGAL_CITY`                                             | Operator city.                                                                                                                                                                                     | Optional. Commented                                                                                     |
| `LEGAL_COUNTRY`                                          | Operator country.                                                                                                                                                                                  | Optional. Commented                                                                                     |
| `LEGAL_JURISDICTION_CITY`                                | City of legal jurisdiction.                                                                                                                                                                        | Optional. Commented                                                                                     |
| `LEGAL_EMAIL`                                            | Legal contact email.                                                                                                                                                                               | Optional. Commented                                                                                     |
| `LEGAL_PHONE`                                            | Legal contact phone.                                                                                                                                                                               | Optional. Commented                                                                                     |
| `LEGAL_SUPERVISORY_AUTHORITY`                            | Data-protection supervisory authority (name + address) named on `/privacy`. Leave blank to omit the sentence.                                                                                      | Optional. Commented                                                                                     |
| `LEGAL_SUPERVISORY_AUTHORITY_URL`                        | URL of the supervisory authority above.                                                                                                                                                            | Optional. Commented                                                                                     |
| `LEGAL_HOSTING_PROVIDER`                                 | Hosting provider (name + address) disclosed on `/privacy`. Leave blank to omit.                                                                                                                    | Optional. Commented                                                                                     |
| `LEGAL_HOSTING_LOCATIONS`                                | Human-readable hosting locations shown on `/privacy`, e.g. `Germany and Finland (EU)`.                                                                                                             | Optional. Commented                                                                                     |
| `LEGAL_SERVER_LOG_RETENTION_DAYS`                        | Days persisted API warning/error logs are retained and disclosed on `/privacy`. Container logs remain an infrastructure setting.                                                                   | Optional. Default `30`                                                                                  |

:::tip[Legal pages]
The legal fields are optional but required for complete production
`/terms` and `/privacy` pages. Leave them blank to omit the corresponding rows.
:::

## Data-use policy

Each data source declares whether it may be used commercially. By default the
stack serves **everything** — the reference deployment is non-commercial — but a
commercial operator can exclude licence-restricted sources. These are resolved
env-first, then the admin toggle at `/admin/settings`, then the default, and have
no entry in `.env.example`; set them only if you need to restrict. See
[Data-use policy](../administration/integrations-administration.md#data-use-policy)
for what each class covers.

| Variable                       | Description                                                                                                                        | Required / Default       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `OPENMAPX_ALLOW_NONCOMMERCIAL` | Set to `false`/`0` to exclude sources whose licence forbids commercial use (`commercialUse: "no"`). Overrides the admin toggle.    | Optional. Default `true` |
| `OPENMAPX_ALLOW_GREY_AREA`     | Set to `false`/`0` to exclude sources with unclear or undocumented terms (`commercialUse: "unknown"`). Overrides the admin toggle. | Optional. Default `true` |

## Overture Maps POIs

Schedules and switches for the regional Overture Maps Places refresh.

| Variable                             | Description                                                                                                                                            | Required / Default                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `OVERTURE_ENABLED`                   | Set to `true` to discover and atomically import newer Overture Places releases for `OPENMAPX_REGION`.                                                  | Optional. Default unset                                   |
| `OVERTURE_SYNC_CRON`                 | Cron schedule for checking and refreshing the regional snapshot.                                                                                       | Optional. Default `0 5 * * 2` (weekly, Tuesday 05:00 UTC) |
| `OVERTURE_CONFLATION_RETRY_CRON`     | Retry an incomplete OSM↔Overture link rebuild without downloading or importing Places again. Recovery also runs once at startup.                       | Optional. Default `*/15 * * * *`                          |
| `OVERTURE_RELEASE_RETENTION`         | Number of completed local release snapshots to retain, including the active release. Applied only after fused quality validation and link publication. | Optional. Default `2`; range 1–12                         |
| `OVERTURE_DISK_RESERVE_BYTES`        | Free-space safety reserve kept beyond estimated pull/ingest working space.                                                                             | Optional. Default `5368709120` (5 GiB)                    |
| `OVERTURE_FIRST_PULL_ESTIMATE_BYTES` | Working-space estimate for the first regional pull when no earlier snapshot exists. Later pulls use prior local snapshot sizes.                        | Optional. Default `2147483648` (2 GiB)                    |

The job uses Overture's official STAC catalog, skips an installed release,
resolves exact spatially relevant Places assets, validates a local release
contract, pulls only the configured region, and swaps a fully validated staging
schema into service. OSM↔GERS link rebuilding has a separate durable state and
retry schedule with resumable extraction, scoring, assignment, and publication
phases: a missing PBF or failed rebuild does not roll back a valid Places
release. See [Overture Places](../features/overture-places.md).

After the first successful ingest, enable `poi-overture` in **Admin →
Integrations** to return Overture search results and `knowledge-overture` to
enrich matched OSM place cards. `OVERTURE_ENABLED` maintains the data but does
not silently enable either runtime integration.

## Notable places for search

The data-manager keeps an index of places that many Wikipedias cover, fetched
from Wikidata, so search can tell the Louvre in Paris from a bar called Louvre
nearby without a self-hosted geocoder. About 1,000 cities known worldwide (100
or more language editions) are indexed too, so a city is found by its name in
other languages: "rom" finds Rome. Things Wikidata gives a coordinate but that
are no place to go to (events, languages, historical states, sports clubs,
craters on the Moon) are left out. It builds the index once when none is
published and refreshes it on a schedule; a failed refresh keeps the previous
snapshot, and a busy endpoint is retried for a few minutes first.
**Admin → Data workflows → Notable places** shows the snapshot and rebuilds it
on demand.

| Variable                       | Description                                                                                                         | Required / Default                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `NOTABLE_PLACES_REFRESH_CRON`  | Cron schedule for the refresh. `off` disables both the refresh and the first build, and no request leaves the host. | Optional. Default `0 2 1 * *` (monthly, 1st, 02:00 UTC) |
| `NOTABLE_PLACES_SPARQL_URL`    | Wikidata SPARQL endpoint that supports QLever's per-language label predicates.                                      | Optional. Default `https://qlever.dev/api/wikidata`     |
| `NOTABLE_PLACES_MIN_SITELINKS` | Wikipedia language editions a place needs to be indexed. Smaller settlements are left out; geocoders rank them.     | Optional. Default `8` (about 135,000 places, ~280 MB)   |

## Natural-language search

[Natural-language search](../features/natural-language-search.md) (the
`search-nlp` integration) is normally configured at `/admin/integrations`.
It is **cloud-off by default**: the provider list contains local Ollama followed
by keyword parsing. A cloud model is used only when it is listed, its credential
exists, and the active privacy policy authorizes cloud. If you would rather pin
the configuration from the environment, use the per-integration form below
(`INTEGRATION_SEARCH_NLP_<KEY>`). `PROVIDERS` must contain a JSON array.

| Variable                                       | Description                                                                                                                     | Required / Default         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `INTEGRATION_SEARCH_NLP_PROVIDERS`             | Ordered JSON definitions for `keyword`, `ollama`, `anthropic`, `openai`, `google`, `openrouter`, or `openai-compatible`.        | Local Ollama, then keyword |
| `INTEGRATION_SEARCH_NLP_PRIVACYMODE`           | `strict` disables cloud server-side; `consent` requires explicit user consent; `open` permits server-policy-deferred cloud use. | `consent`                  |
| `INTEGRATION_SEARCH_NLP_ROUNDCOORDSDECIMALS`   | Decimal places retained for the map center sent to a model and used in cache partitioning.                                      | `2`; range 0–5             |
| `INTEGRATION_SEARCH_NLP_INTENTCACHETTLSECONDS` | Parsed-intent cache lifetime in seconds.                                                                                        | `86400`                    |
| `INTEGRATION_SEARCH_NLP_RATELIMITPERIPPERHOUR` | Fixed-window parse limit per client IP.                                                                                         | `200`                      |
| `INTEGRATION_SEARCH_NLP_ANTHROPICAPIKEY`       | Credential for `anthropic` definitions.                                                                                         | Optional; unset            |
| `INTEGRATION_SEARCH_NLP_OPENAIAPIKEY`          | Credential for `openai` definitions.                                                                                            | Optional; unset            |
| `INTEGRATION_SEARCH_NLP_GOOGLEAPIKEY`          | Credential for `google` (Gemini) definitions.                                                                                   | Optional; unset            |
| `INTEGRATION_SEARCH_NLP_OPENROUTERAPIKEY`      | Credential for `openrouter` definitions.                                                                                        | Optional; unset            |
| `INTEGRATION_SEARCH_NLP_COMPATIBLEAPIKEY`      | Dedicated credential for custom compatible endpoint definitions.                                                                | Optional; unset            |

For example, this pins a Gemini-first chain from `.env`:

```bash
INTEGRATION_SEARCH_NLP_PROVIDERS='[{"id":"gemini","type":"google","model":"gemini-2.5-flash"},{"id":"local","type":"ollama","model":"gemma3:4b-it-qat"},{"id":"keyword","type":"keyword"}]'
INTEGRATION_SEARCH_NLP_PRIVACYMODE=consent
INTEGRATION_SEARCH_NLP_GOOGLEAPIKEY=replace-with-vault-or-environment-secret
```

Environment values override admin-stored values. Prefer the Credentials tab for
secrets when you do not need an immutable deployment-level override. See the
[provider reference](../features/natural-language-search.md#provider-architecture)
for every definition field, OpenRouter privacy controls, and custom endpoint
requirements.

To run the local model, enable the **`local-ai`** backend service (Ollama). Its
container tuning uses the usual per-service form — `LOCAL_AI_MEMORY` (default
`8g`), `OLLAMA_KEEP_ALIVE` (default `30m`), `OLLAMA_MAX_LOADED_MODELS` (default
`1`).

## Per-integration and per-service overrides

Most integration credentials and per-service knobs are _not_ set here — they are
managed in the admin UI, and env values always win over admin-stored ones:

- `/admin/integrations` — per-integration detail pages.
- `/admin/integrations/bulk` — every integration on one page, plus a generated
  catalogue (Copy config / Copy credentials / Copy all) you can paste into
  `.env`.
- `/admin/services/<id>` — per-service config, exposed as
  `SERVICE_<ID>_<KEY>` (for example `SERVICE_VALHALLA_MEMORY_LIMIT=4g`).

Nothing in these override blocks is required at deploy time. Paste only the
lines you want to pin from the bulk page; the admin UI generates them on demand
so the catalogue stays in sync with the live manifests.

## Where to go next

- **[How it works](../overview/how-it-works.md)** — the service/integration model
  these variables wire together.
- **[Requirements](./requirements.md)** — host prerequisites and hardware sizing
  for the engines you enable.
- **[Getting started](./getting-started.md)**, **[Preparing data](./preparing-data.md)**,
  and **[Managing services](./managing-services.md)** — the step-by-step
  deployment, data-build, and lifecycle walkthroughs.
