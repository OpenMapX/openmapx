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
  and so on) are managed at `/admin/integrations`. Anything you *do* set in
  `.env` always wins over an admin-stored value. See
  [How it works](../overview/how-it-works.md) for the service/integration model.

:::caution[Recreate containers after editing]
Changing `.env` only takes effect when the affected containers are recreated.
Re-run `docker compose up -d` (Compose detects the changed file and recreates
what's needed) or restart through the CLI's service commands.
:::

## Core / required

The values without which the stack won't start. Generate the secrets — never
ship the placeholders.

| Variable                  | Description                                                                                                                             | Required / Default            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `DOMAIN`                  | Public domain. Drives Traefik routing, the auth URLs (`BETTER_AUTH_URL`, `PASSKEY_RP_ID`, `PASSKEY_ORIGIN`), the web app's `NEXT_PUBLIC_API_URL`, tile-server URLs, and the outbound contact identity (the contact address in third-party User-Agent strings and the email `From` fallback). Point both an A and an AAAA record at the host. | Default `localhost`           |
| `ACME_EMAIL`              | Contact email for Traefik's automatic Let's Encrypt TLS certificates.                                                                   | Default `admin@example.com`   |
| `POSTGRES_PASSWORD`       | Password for the PostgreSQL/PostGIS database (used by `postgis`, `app-api`, and `data-manager`). Compose refuses to start if unset. Generate with `openssl rand -hex 32`. | **Required**                  |
| `OPENMAPX_HOST_DIR`       | Absolute host path of the OpenMapX repo checkout. The `app-api` container shells out to `docker compose` from inside the container and bind-mounts this path at the same path on both sides, so generated bind sources like `./data` resolve correctly. Find it with `pwd` from the repo root. | **Required** (no default)     |
| `DOCKER_GID`              | The host's docker-socket group id. Containers that mount the docker socket run as a non-root user and must join this group, or the data-manager's MOTIS import/promote fails with "permission denied". Host-specific — find it with `stat -c %g /var/run/docker.sock`. Compose has no fallback, so it must be set; `.env.example` pre-fills `999`. | **Required**                  |

:::note[Domain and TLS networking]
Traefik serves HTTP/3 (QUIC) on UDP/443 and the OpenMapX Docker network is
dual-stack. For IPv6 to reach published ports, the Docker daemon needs
`ip6tables` enabled — the default in Docker Engine 27+, otherwise add
`{"experimental": true, "ip6tables": true}` to `/etc/docker/daemon.json` and
restart the daemon.
:::

## Secrets

Authentication and internal service secrets. The first two are enforced at
runtime by the API; `DATA_MANAGER_AUTH_TOKEN` is enforced at the Compose layer.
Generate each with the command shown.

| Variable                     | Description                                                                                                                                          | Required / Default                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `BETTER_AUTH_SECRET`         | Better Auth session-signing key. No fallback — the API refuses to start without it. Generate with `npx @better-auth/cli@latest secret`.             | **Required**                                    |
| `OPENMAPX_SECRETS_KEY`       | Symmetric key (32 bytes, hex — 64 chars) used to encrypt integration secrets stored in the vault. If unset, integrations that store secrets in the admin panel won't decrypt after a restart. Generate with `openssl rand -hex 32`. | **Required** (to use the secret vault)          |
| `DATA_MANAGER_AUTH_TOKEN`    | Shared secret between `app-api` and the `data-manager` service; every data-manager mutation endpoint (downloads, hardlinks, dataset reload, conversions) requires it. Compose refuses to start without it in production; development generates a random ephemeral token. Generate with `openssl rand -hex 32`. | **Required** in production                      |
| `OPENMAPX_LOCAL_ADMIN_TOKEN` | Shared secret for the CLI ↔ API loopback admin short-circuit. When set, loopback requests only gain admin if they carry a matching `X-OpenMapX-Local-Admin` header (a CSRF guard); the CLI attaches it automatically. In production with no token, the loopback bypass is denied and the CLI needs a web-login session cookie. Generate with `openssl rand -hex 32`. | Optional (recommended). Default unset           |

## Docker & host wiring

How the containers find the host, the repo, and bind-mounted volumes. The
required pieces of this group are listed under [Core / required](#core--required)
(`OPENMAPX_HOST_DIR`, `DOCKER_GID`); the rest are optional.

| Variable                            | Description                                                                                                          | Required / Default              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `OPENMAPX_CUSTOM_INTEGRATIONS_DIR`  | Container path where community integrations (installed by the admin panel or CLI) are mounted. Leave at the default unless you also change the `app-api` bind-mount target. | Default `/app/custom_integrations` |
| `UID`                               | Host UID for bind-mounted volumes (Linux). macOS/Windows usually don't need this — Docker Desktop handles ownership. | Optional. Commented `1000`      |
| `GID`                               | Host GID for bind-mounted volumes (Linux). Same caveat as `UID`.                                                    | Optional. Commented `1000`      |
| `DATA_MANAGER_URL`                  | Base URL `app-api` uses to reach the data-manager. Compose overrides this to the service-network DNS name automatically. | Default `http://localhost:4000` (`pnpm dev`); compose sets `http://data-manager:4000` |
| `OPENMAPX_ENABLED_SERVICES`         | Pin a specific service selection (comma- or space-separated) for CI/repeatable deploys. Wins over the `service-selection.json` written by the admin UI / CLI. | Optional. Default: `service-selection.json` |
| `OPENMAPX_DOCKER_CONFIG_DIR`        | Host directory holding Docker registry credentials, mounted into `app-api` so the extension store's **Update** can pull private GHCR images. On the reference deploy this is `/home/ubuntu/.docker`. | Optional. Default unset |

## Authentication & OAuth

Optional social-login providers. Each requires an OAuth app registered with the
provider.

| Variable                   | Description                                                                                | Required / Default        |
| -------------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `OSM_CLIENT_ID`            | OpenStreetMap OAuth client id. Register at the [OSM OAuth applications page](https://www.openstreetmap.org/oauth2/applications). | Optional. Commented       |
| `OSM_CLIENT_SECRET`        | OpenStreetMap OAuth client secret.                                                        | Optional. Commented       |
| `MAPILLARY_CLIENT_ID`      | Mapillary OAuth client id (re-uses the same app as `MAPILLARY_TOKEN`). Register at the [Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers). | Optional. Commented       |
| `MAPILLARY_CLIENT_SECRET`  | Mapillary OAuth client secret.                                                            | Optional. Commented       |

## Map style & tiles

Tile-source selection and keys. The `NEXT_PUBLIC_*` values (except
`NEXT_PUBLIC_API_URL`) are read per-request via the web app's `EnvProvider`, so
runtime changes reach both server and client components without a rebuild.

| Variable                                  | Description                                                                                                                 | Required / Default        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `NEXT_PUBLIC_STYLE_PROVIDER`              | Tile source. `maptiler` uses MapTiler Cloud (needs a key); `openmapx` uses the self-hosted tile stack (needs the tiles profile). | Default `maptiler`        |
| `MAPTILER_KEY`                            | MapTiler Cloud API key. Also settable in `/admin/settings → Map`. Leave commented to manage from the admin UI; uncomment to lock a value (env wins). | Optional. Commented       |
| `NEXT_PUBLIC_MAP_STYLE_URL`               | Base URL of the self-hosted `tileserver-gl`; the web app appends `/styles/<style>/style.json`. With the built-in Traefik route this is `${DOMAIN}/tiles`. | Optional. Commented       |
| `NEXT_PUBLIC_TILES_URL`                   | Self-hosted tile JSON URL.                                                                                                 | Optional. Commented       |
| `NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE`   | Override URL template for the traffic raster layer.                                                                       | Optional. Commented       |
| `NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE`   | Override URL template for the CyclOSM layer.                                                                              | Optional. Commented       |
| `NEXT_PUBLIC_TERRAIN_TILE_URL_TEMPLATE`   | Override URL template for the terrain layer.                                                                              | Optional. Commented       |

## Street-level imagery

Mapillary tokens for street-level imagery. One stays server-side; the viewer
token ships in the browser bundle.

| Variable                  | Description                                                                                                                                 | Required / Default        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `MAPILLARY_TOKEN`         | Server-side Mapillary token used by the `/api/mapillary/*` vector-tile proxy and integrations that fetch Mapillary on the user's behalf. Stays server-side — street-level imagery is proxied through the API, so no Mapillary token reaches the browser. | Optional. Default unset   |

## Backend endpoint overrides

Self-hosted backends are normally resolved from the service registry. These
overrides force a specific (often public) endpoint instead — useful when a
backend runs outside the Compose stack. All optional and commented by default.

| Variable            | Description                                                                                                        | Required / Default                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `INTEGRATION_ROUTING_OSRM_ENDPOINT` | OSRM endpoint for the routing provider (car routing). Usually unset — a co-deployed `osrm` service is auto-resolved over the internal network. | Optional. Default unset |
| `OSRM_URL`          | OSRM endpoint used by the `app-api` road-snap helper (distinct from the routing provider above). Usually unset — the co-deployed `osrm` service is used. | Optional. Default unset |
| `VALHALLA_URL`      | Valhalla endpoint for isochrones, elevation, and road-snap (bus). The default targets Stadia Maps' hosted Valhalla, which requires `VALHALLA_API_KEY`; a self-hosted Valhalla needs no key. The routing/directions **provider** resolves separately — via the co-deployed `valhalla` service or `INTEGRATION_ROUTING_VALHALLA_ENDPOINT` / `INTEGRATION_ROUTING_VALHALLA_APIKEY`. | Optional. Commented `https://api.stadiamaps.com` |
| `VALHALLA_API_KEY`  | API key for the hosted Valhalla above (free non-commercial tier at [stadiamaps.com](https://stadiamaps.com/)). Leave blank for a self-hosted Valhalla. | Optional. Default unset             |
| `MOTIS_URL`         | MOTIS endpoint for the transit manager and shared local MOTIS helpers. Over the internal network MOTIS listens on `8080` (`8081` is only the host-loopback mapping). | Optional. Commented `http://motis:8080` |
| `OVERPASS_URL`      | Overpass API endpoint used by the core Overpass client.                                                          | Optional. Commented `http://overpass:80` |
| `NOMINATIM_URL`     | Nominatim endpoint for station reverse-geocoding (bike / scooter / car sharing).                                 | Optional. Commented `http://nominatim:8080` |
| `TRANSITOUS_URL`    | Transitous endpoint for rental POIs used by shared-mobility integrations.                                        | Optional. Commented `https://api.transitous.org` |

## Regional defaults

Default regions and country filters used by the CLI and selected services, so
you can keep them here instead of repeating CLI flags. A region passed on the
command line overrides the env value for that invocation.

| Variable                          | Description                                                                                                            | Required / Default            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `OPENMAPX_REGION`                 | Shared default OSM region for selectors like `openmapx data download osm`, `services build`, and `data convert overpass`. | Optional. Commented `europe/germany` |
| `OSRM_REGION`                     | Per-service OSRM build region (wins over `OPENMAPX_REGION` for that target).                                          | Optional. Commented           |
| `OTP_REGION`                      | Per-service OTP build region.                                                                                         | Optional. Commented           |
| `MOTIS_REGION`                    | Per-service MOTIS build region.                                                                                       | Optional. Commented `planet`  |
| `PELIAS_REGION`                   | Per-service Pelias build region.                                                                                      | Optional. Commented           |
| `TILESERVER_REGION`              | Per-service TileServer GL build region.                                                                               | Optional. Commented           |
| `OVERPASS_REGION`                 | Per-service Overpass build region.                                                                                    | Optional. Commented           |
| `TRANSITOUS_COUNTRIES`            | Country filter (e.g. `de,at,ch`) for `data download gtfs` and MOTIS Transitous config generation.                    | Optional. Commented           |
| `INTEGRATION_GEOCODING_PROVIDER`  | Comma-separated geocoding fallback chain, tried left to right. Valid names: `maptiler`, `photon`, `nominatim`, `pelias`, `motis`, `transitous`, `entur`, `db-ris`. | Optional. Default `maptiler`  |
| `PHOTON_REGION`                   | Runtime download region for the self-hosted Photon index.                                                            | Default `planet`              |

## Service tuning

Knobs forwarded into the backend containers. Defaults are sensible for most
deployments.

| Variable                        | Description                                                                | Required / Default        |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `NOMINATIM_THREADS`             | Import/query thread count for the self-hosted Nominatim geocoder.         | Default `8`               |
| `NOMINATIM_IMPORT_WIKIPEDIA`    | Import Wikipedia importance scores during the Nominatim build.            | Default `true`            |
| `NOMINATIM_IMPORT_GB_POSTCODES` | Import GB postcodes.                                                       | Default `false`           |
| `NOMINATIM_IMPORT_US_POSTCODES` | Import US postcodes.                                                       | Default `false`           |
| `OVERPASS_SPACE`                | Overpass database space limit, in bytes.                                  | Default `107374182400` (~100 GiB) |
| `OVERPASS_FASTCGI_PROCESSES`    | Number of Overpass FastCGI worker processes.                             | Default `4`               |

## Traffic & extra tile providers

Keys and overrides for the `app-api` traffic and tile proxies.

| Variable                       | Description                                                                                  | Required / Default        |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------- |
| `TRAFFIC_PROVIDER`             | Traffic data provider.                                                                       | Default `tomtom`          |
| `TOMTOM_TRAFFIC_KEY`           | TomTom Flow tile-proxy key. Sign up at [developer.tomtom.com](https://developer.tomtom.com/). | Optional. Default unset   |
| `TOMTOM_TRAFFIC_URL`           | TomTom API base URL.                                                                         | Optional. Commented `https://api.tomtom.com` |
| `TOMTOM_TRAFFIC_VERSION`       | TomTom Flow API version.                                                                     | Optional. Commented `4`   |
| `TOMTOM_TRAFFIC_STYLE`         | TomTom Flow tile style.                                                                      | Optional. Commented `relative-delay` |
| `TOMTOM_TRAFFIC_TILE_SIZE`     | TomTom tile size in pixels.                                                                  | Optional. Commented `256` |
| `TOMTOM_TRAFFIC_THICKNESS`     | TomTom Flow line thickness.                                                                  | Optional. Commented `2`   |
| `THUNDERFOREST_API_KEY`        | Thunderforest OpenCycleMap key (free Hobby Project key at [thunderforest.com](https://www.thunderforest.com/)). | Optional. Default unset   |
| `CYCLOSM_TILE_URL`             | Override URL for the CyclOSM tile proxy.                                                     | Optional. Commented       |
| `WAYMARKED_CYCLING_TILE_URL`   | Override URL for the Waymarked Trails cycling layer.                                         | Optional. Commented       |
| `OPENTOPOMAP_TILE_URL`         | Override URL for the OpenTopoMap layer.                                                      | Optional. Commented       |

## Email

Used for email verification, 2FA, and email-change flows. The provider is
auto-detected by priority: **EmailLabs > Lettermint > SMTP**. These are also
settable in `/admin/settings → Email / SMTP`; env always wins.

| Variable                | Description                                                                  | Required / Default        |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------- |
| `EMAIL_FROM`            | Sender address, e.g. `OpenMapX <noreply@openmapx.example.com>`.             | Optional. Commented       |
| `EMAILLABS_APP_KEY`     | EmailLabs app key ([emaillabs.io](https://emaillabs.io), 9k emails/mo free). | Optional. Commented       |
| `EMAILLABS_SECRET_KEY`  | EmailLabs secret key.                                                       | Optional. Commented       |
| `EMAILLABS_SMTP_ACCOUNT`| EmailLabs SMTP account.                                                     | Optional. Commented       |
| `LETTERMINT_API_TOKEN`  | Lettermint API token ([lettermint.co](https://lettermint.co), 300 emails/mo free). | Optional. Commented       |
| `SMTP_HOST`             | SMTP server hostname (any provider).                                        | Optional. Commented       |
| `SMTP_PORT`             | SMTP port.                                                                  | Optional. Commented `587` |
| `SMTP_SECURE`           | Use TLS on connect.                                                         | Optional. Commented `false` |
| `SMTP_USER`             | SMTP username.                                                              | Optional. Commented       |
| `SMTP_PASS`             | SMTP password.                                                              | Optional. Commented       |

## Transitous & cron

Schedules and tuning for the daily Transitous transit-data sync.

| Variable                              | Description                                                                                                  | Required / Default            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `TRANSIT_SOURCE`                      | How the Transitous dataset is obtained: `mirror` (default — download the prebuilt community bundle) or `build` (assemble it locally from feeds). See [Transit engines](../guides/transit-engines.md). | Optional. Default `mirror` |
| `TRANSITOUS_ARTIFACT_BASE_URL`        | Base URL the `mirror` mode pulls the prebuilt Transitous artifact from. | Optional. Default unset (upstream) |
| `TRANSITOUS_SYNC_CRON`                | Cron schedule for the daily Transitous sync. Leaving it unset (or empty) uses the built-in `0 3 * * *`; set it to `disabled` (or `off`/`false`) to turn it off (e.g. on a staging host where you trigger manually). | Optional. Commented `0 3 * * *` |
| `TRANSITOUS_STALENESS_CHECK_CRON`     | Cron schedule for the staleness sweep that flags feeds that have stopped updating. Set to `disabled` (or `off`/`false`) to turn it off. | Optional. Commented `0 4 * * *` |
| `TRANSITOUS_FEED_PROXY_RELOAD_CRON`   | Cron schedule for the feed-proxy nginx-reload heartbeat — a safety net against a missed reload during sync. | Optional. Commented `*/15 * * * *` |
| `TRANSITOUS_AUTO_BUMP_CRON`           | Opt-in cron that advances the pinned Transitous catalog to upstream's latest behind the staging-slot canary — activates the new pin (and promotes) only if the candidate builds and passes the functional probes, otherwise keeps the current pin and alerts. **Unset/empty = disabled** (the pin stays frozen). See [Transit engines](../guides/transit-engines.md). | Optional. Default disabled |
| `TRANSITOUS_ALERT_GH_TOKEN` / `TRANSITOUS_ALERT_GH_REPO` | When both are set, sync/auto-bump failures and stale feeds open deduped GitHub issues instead of being log-only. Without them a canary rejection can silently freeze the live dataset for days. | Optional. Default log-only |
| `MOTIS_RENTALS_WARMUP_MS` / `MOTIS_RENTALS_POLL_INTERVAL_MS` | How long the rentals canary re-polls MOTIS `/rentals` while it enumerates zero providers (GBFS warm-up after a restart) before failing, and the interval between polls. | Optional. Default `180000` / `5000` |

:::note[Transitous feed-proxy key]
The optional age private key used to decrypt `AGE-ENCRYPTED:` feed values has no
env variable. Drop the file at `infra/docker/secrets/transitous-feed-proxy.age`
on the host and re-render compose; the mount is omitted automatically when the
file is absent. See `infra/docker/secrets/README.md` for the generation steps.
:::

## Advanced & optional

Lower-level toggles, retention, and legal-page metadata. All optional.

| Variable                          | Description                                                                                                       | Required / Default        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `LOG_LEVEL`                       | Fastify log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).                                          | Optional. Commented `info` |
| `OPENMAPX_DISABLE_LOCALHOST_AUTH` | Set to `1` to disable the loopback admin short-circuit entirely, regardless of `OPENMAPX_LOCAL_ADMIN_TOKEN`. Use on multi-tenant hosts where another local process could reach the API's loopback. | Optional. Commented       |
| `ISOCHRONE_PROVIDER`              | Isochrone provider. Use `otp` to route isochrones through OpenTripPlanner instead of Valhalla.                   | Optional. Commented. Default `valhalla` |
| `AUDIT_LOG_RETENTION_DAYS`        | Days to keep admin audit-log entries before the daily prune.                                                     | Optional. Commented `90`  |
| `ADMIN_JOB_RETENTION_DAYS`        | Days to keep finished admin jobs (in-flight jobs are never pruned).                                              | Optional. Commented `30`  |
| `GITHUB_TOKEN`                    | GitHub API token — raises the Transitous catalog fetch rate limit from 60 to 5000 req/h. Needed only on multi-tenant hosts. | Optional. Commented       |
| `EXTENSION_CATALOG_URL`           | Default catalog URL for the **Extensions** store — the curated (verified-tier) list shown under `/admin/extensions`. | Optional. Commented `https://raw.githubusercontent.com/openmapx/community-extensions/main/catalog.json` |
| `LEGAL_NAME`                      | Operator legal name shown on `/terms` and `/privacy`.                                                            | Optional. Commented       |
| `LEGAL_STREET`                    | Operator street address.                                                                                         | Optional. Commented       |
| `LEGAL_POSTAL_CODE`               | Operator postal code.                                                                                            | Optional. Commented       |
| `LEGAL_CITY`                      | Operator city.                                                                                                   | Optional. Commented       |
| `LEGAL_COUNTRY`                   | Operator country.                                                                                                | Optional. Commented       |
| `LEGAL_JURISDICTION_CITY`         | City of legal jurisdiction.                                                                                      | Optional. Commented       |
| `LEGAL_EMAIL`                     | Legal contact email.                                                                                             | Optional. Commented       |
| `LEGAL_PHONE`                     | Legal contact phone.                                                                                             | Optional. Commented       |
| `LEGAL_SUPERVISORY_AUTHORITY`     | Data-protection supervisory authority (name + address) named on `/privacy`. Leave blank to omit the sentence.    | Optional. Commented       |
| `LEGAL_SUPERVISORY_AUTHORITY_URL` | URL of the supervisory authority above.                                                                          | Optional. Commented       |
| `LEGAL_HOSTING_PROVIDER`          | Hosting provider (name + address) disclosed on `/privacy`. Leave blank to omit.                                  | Optional. Commented       |
| `LEGAL_HOSTING_LOCATIONS`         | Human-readable hosting locations shown on `/privacy`, e.g. `Germany and Finland (EU)`.                           | Optional. Commented       |
| `LEGAL_SERVER_LOG_RETENTION_DAYS` | Days server logs are retained, stated on `/privacy`. Must be a whole number; a non-numeric value is ignored.     | Optional. Default `30`    |

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

| Variable                       | Description                                                                                                       | Required / Default        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `OPENMAPX_ALLOW_NONCOMMERCIAL` | Set to `false`/`0` to exclude sources whose licence forbids commercial use (`commercialUse: "no"`). Overrides the admin toggle. | Optional. Default `true`  |
| `OPENMAPX_ALLOW_GREY_AREA`     | Set to `false`/`0` to exclude sources with unclear or undocumented terms (`commercialUse: "unknown"`). Overrides the admin toggle. | Optional. Default `true`  |

## Overture Maps POIs

Schedules and switches for the monthly Overture Maps POI data ingestion.

| Variable           | Description                                                                                  | Required / Default        |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------- |
| `OVERTURE_ENABLED`  | Set to `true` to enable the monthly download and ingestion of Overture Maps POI data.        | Optional. Default unset   |
| `OVERTURE_SYNC_CRON`| Cron schedule for the monthly Overture POI ingestion run.                                  | Optional. Default `0 5 1 * *` (monthly) |

## Natural-language search

[Natural-language search](../features/natural-language-search.md) (the
`search-nlp` integration) is configured at `/admin/integrations`, not in `.env`.
It is **cloud-off by default**: the provider chain is `local, keyword`, and a
cloud model is used only when it is both listed in the chain and given an API
key. If you'd rather pin its config from the environment, use the
per-integration override form below (`INTEGRATION_SEARCH_NLP_<KEY>`) — scalar
keys map cleanly; the `providerChain` array is best set from the admin UI.

| Variable                                   | Description                                                                                       | Required / Default                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `INTEGRATION_SEARCH_NLP_PRIVACYMODE`       | `strict` (cloud disabled server-side), `consent` (cloud behind explicit opt-in), or `open`.       | Default `consent`                   |
| `INTEGRATION_SEARCH_NLP_OLLAMAMODEL`       | Local LLM served by the `local-ai` (Ollama) service; pulled automatically on first start.         | Default `gemma3:4b-it-qat`          |
| `INTEGRATION_SEARCH_NLP_OLLAMAENDPOINT`    | Ollama base URL. Defaults to the `local-ai` service URL when that service is enabled.             | Default `http://localhost:11434`    |
| `INTEGRATION_SEARCH_NLP_ANTHROPICAPIKEY`   | Anthropic key. Required to activate the `claude` cloud provider; without it the provider is skipped. | Optional. Default unset          |
| `INTEGRATION_SEARCH_NLP_CLAUDEMODEL`       | Anthropic model id for the `claude` provider.                                                     | Default `claude-haiku-4-5-20251001` |
| `INTEGRATION_SEARCH_NLP_OPENAIAPIKEY`      | OpenAI key. Required to activate the `openai` cloud provider; without it the provider is skipped.  | Optional. Default unset             |
| `INTEGRATION_SEARCH_NLP_OPENAIMODEL`       | OpenAI model id for the `openai` provider.                                                         | Default `gpt-4o-mini`               |

To run the local model, enable the **`local-ai`** backend service (Ollama). Its
container tuning uses the usual per-service form — `LOCAL_AI_MEMORY` (default
`8g`), `OLLAMA_KEEP_ALIVE` (default `30m`), `OLLAMA_MAX_LOADED_MODELS` (default
`1`).

## Per-integration and per-service overrides

Most integration credentials and per-service knobs are *not* set here — they are
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
