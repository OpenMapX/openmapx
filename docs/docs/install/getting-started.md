---
title: Getting started
description: Deploy the OpenMapX application, create the first administrator, and add a regional backend.
sidebar_position: 2
---

# Getting started

These steps deploy OpenMapX on one Linux host using release images and generated
Docker Compose configuration. Complete the [requirements](./requirements.md)
first. Run commands from the repository root as the deployment owner, with
access to the local Docker daemon.

The first deployment starts the default application services. Optional engines
can be added after you have signed in and checked the application.

## 1. Clone and install

```bash
git clone https://github.com/OpenMapX/openmapx.git
cd openmapx
pnpm install --frozen-lockfile
```

Use the Node.js and pnpm versions declared in `package.json`. Only the
deployment owner's account may write the checkout; see
[requirements](./requirements.md).

## 2. Configure your environment

```bash
cp infra/docker/.env.example infra/docker/.env
chmod 600 infra/docker/.env
```

Edit the file before rendering. Supply these values:

| Setting                      | Value to provide                                       |
| ---------------------------- | ------------------------------------------------------ |
| `DOMAIN`                     | Public hostname pointing to this host                  |
| `ACME_EMAIL`                 | Certificate contact email                              |
| `POSTGRES_PASSWORD`          | Unique database password, at least 24 characters       |
| `BETTER_AUTH_SECRET`         | Unique signing secret, at least 32 characters          |
| `OPENMAPX_SECRETS_KEY`       | 32 random bytes encoded as 64 hexadecimal characters   |
| `DATA_MANAGER_AUTH_TOKEN`    | Unique internal token, at least 32 characters          |
| `OPENMAPX_LOCAL_ADMIN_TOKEN` | Unique token for CLI loopback admin requests           |
| `OPENMAPX_HOST_DIR`          | Absolute checkout path, as printed by `pwd`            |
| `DOCKER_GID`                 | Socket group ID from `stat -c %g /var/run/docker.sock` |
| `TRANSITOUS_COUNTRIES`       | Explicit country codes, for example `de`               |

Generate a separate value for each secret with `openssl rand -hex 32`. The
renderer rejects known placeholders and weak database/application secrets.
Do not reuse the database username as its password.

Set `UID` and `GID` to the deployment owner's IDs where they differ from
`1000:1000`. They govern files written by the data-manager and ops-agent.
A root-only Docker credentials directory will not be readable by the default
container user; configure `OPENMAPX_DOCKER_CONFIG_DIR` accordingly if needed.

The default regional transit policy requires countries or an explicit feed
allow-list at data-manager startup, even without MOTIS. Setting countries does
not enable a transit engine. For a first deployment without local transit, set
`TRANSITOUS_SYNC_CRON=disabled` to avoid scheduled preparation until you configure
it; see [Transit engines](../guides/transit-engines.md).

Point DNS at the host and allow TCP 80 and 443 through the firewall for bundled
Traefik and its ACME HTTP challenge. UDP 443 enables HTTP/3. If another proxy
already owns these ports, configure the
[external proxy](./managing-services.md#behind-an-existing-reverse-proxy) first.
Do not publish a nonworking IPv6 address.

See [Configuration](./configuration.md) for optional settings and provider keys.
The CLI loads `.env` into its process; it does not export those values to your
shell. Use a literal hostname in shell examples such as `curl`.

## 3. Enable a minimal set of services

Inspect the default selection:

```bash
pnpm openmapx services selected
```

It includes API, web, PostGIS, Valkey, proxy, well-known files, data-manager,
ops-agent, and the private Transitous runner. Leave it at this selection for the
first boot. Hosted feature providers may need credentials after startup; the
default geocoding chain uses MapTiler.

For optional engines later, use `services enable <id>`. The command retains the
existing roots and adds dependencies. A manually supplied selection replaces
the defaults, so do not copy a file containing only optional engines.

## 4. Render the compose stack

```bash
pnpm openmapx compose render
pnpm openmapx compose release
pnpm openmapx compose release --status
```

Render creates platform secret files and a configuration generation under
`infra/docker/state/ops-agent/configuration/generations/`. The
`infra/docker/state/ops-agent/configuration/current` pointer selects the generated Compose
file and hardlink plan. Keep these deployment files; do not edit generated YAML.

Release resolution writes `infra/docker/state/ops-agent/releases/docker-compose.release.yml`, pinning the
complete application image set. If the registry cannot be reached, restore
access before continuing. `--status` reports the local selection; it does not
inspect running containers. See [Upgrading](./upgrading.md) for channel and pin
changes.

## 5. Bring up the infrastructure first

```bash
pnpm openmapx services start postgis redis traefik app-api data-manager
pnpm openmapx services status
curl --fail --silent --show-error http://localhost:4000/status
```

The command starts declared dependencies, including ops-agent and the private
runner. Data-manager needs the database schema that API startup migrates.
Its status response should include `"ok": true` and `"dataDir": "/data"`.
Use `DATA_MANAGER_HOST_PORT` if you moved its loopback port.

If startup fails, inspect the affected service:

```bash
pnpm openmapx services logs ops-agent --tail 100
pnpm openmapx services logs app-api --tail 100
pnpm openmapx services logs data-manager --tail 100
```

Correct missing secrets, socket access, checkout permissions, or transit scope
before retrying. If you configured an external proxy, omit `traefik` from the
start command because it is excluded from that selection.

## 6. Download source data

Source downloads are needed only for local engines. For a regional OSRM router:

```bash
pnpm openmapx services enable osrm
pnpm openmapx data download osm europe/germany
```

Set `OPENMAPX_REGION=europe/germany` to reuse this default in later download and
build commands. The source is stored under `infra/docker/data/osm/`.

Hosted-only deployments can skip this step. TileServer GL and offline packages
also need `data download fonts`; transit preparation has additional prerequisites
in [Preparing data](./preparing-data.md).

## 7. Build prepared artifacts

For the optional OSRM router:

```bash
pnpm openmapx services build osrm --region europe/germany
```

This prepares the graph, renders configuration, and links its output. An existing
OSRM consumer must be stopped before rebuilding. The build refuses planet input.

Use explicit service IDs. `services build-all` builds **every installed buildable
service**, including unselected engines. It is not a shortcut for building only
the small stack chosen here.

## 8. Apply the hardlink plan

```bash
pnpm openmapx data link
```

This renders and applies producer-to-consumer hardlinks under
`infra/docker/data/`. Build and start commands also apply them. Producer and
consumer directories must share a filesystem; derived indexes still occupy
additional disk space.

## 9. Bring up the full stack

```bash
pnpm openmapx compose up
pnpm openmapx services status
```

This starts all services in the current selection, retaining the release overlay.
If you added a first-import engine such as Nominatim or Valhalla, expect a long
preparation period and monitor its logs. Start heavy engines individually if
concurrent imports would exceed the host's capacity.

Open `https://your-domain`. Confirm the application loads with a valid
certificate. Certificate failures usually require checking DNS, inbound port 80,
proxy routing, and Traefik logs.

## 10. Create your first admin user

Sign up in the web application, then promote that account:

```bash
pnpm openmapx users promote you@example.com
```

If email is not configured and sign-in is waiting for verification, verify your
bootstrap account from the host:

```bash
pnpm openmapx users verify you@example.com
```

Sign in and open `/admin`. Configure email delivery for later users. Choose your
geocoding provider, provider credentials, and other integrations there. The
bundled style uses keyless OpenFreeMap vectors when no local tiles or MapTiler
key is configured; satellite imagery and other features have separate needs.

Verify a search and route within your prepared coverage. A healthy container
alone does not establish that the data or provider configuration works.

## Where to go next

- [Configuration](./configuration.md) for secrets, host wiring, and overrides.
- [Managing services](./managing-services.md) for selection and lifecycle commands.
- [Preparing data](./preparing-data.md) for engine-specific preparation.
- [Upgrading](./upgrading.md) for backups, image selection, and recovery.
