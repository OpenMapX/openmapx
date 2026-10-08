---
title: Community extensions
description: Browse, install, and manage third-party extensions from the unified Extensions store — integrations, services, and bundles of both — and understand the trust model.
sidebar_position: 4
---

# Community extensions

OpenMapX ships with a large set of first-party services and integrations, but
its plugin model is open: anyone can publish an **extension** and you install it
into your own deployment from one place — the **Extensions store**
(**Extensions** in the admin panel, or `pnpm openmapx ext` on the CLI).

An extension bundles the parts of one feature so you install it in a single
action. A bundle may contain:

- **integrations** — declarative app metadata and presentation assets.
  Distributed as prebuilt `.tar.gz` artifacts, pinned by SHA-256. Community
  backend JavaScript is rejected rather than run in a privileged host process.
- **services** — backend containers: a database, a routing engine, an alternative
  geocoder, a data processor. Distributed as Git repositories, pinned by tag or
  commit.

Most extensions are a single component (one integration, or one service); others
bundle several, like [OpenConditions](#example-openconditions) with its two
services. Either way you install it the same way, and the platform orchestrates
the parts.

:::warning[You are running third-party code]
A community extension can contain code you did not write. Executable backend
behavior runs as a separately sandboxed service; app-api and data-manager never
import community runtime modules. Executable community presentation is disabled
until it has a cross-origin sandbox and narrow capability protocol. Verification
(see [trust tiers](#trust-tiers)) is
an identity and automated-validation check — **not a security audit**. Install
only from authors you trust, and read what an extension installs before you
confirm.
:::

## Trust tiers

Every extension carries one trust tier, and the tier is assigned by **where it
came from** — a manifest can advertise but never grant its own trust:

| Tier          | Meaning                                                      | Source                                                                                                     |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **built-in**  | Ships in the OpenMapX monorepo                               | first-party                                                                                                |
| **verified**  | Identity-checked + passed automated validation (not audited) | the curated OpenMapX catalog (`openmapx/community-extensions`), where inclusion is a CI-gated pull request |
| **community** | Unreviewed                                                   | a catalog source you added yourself, or a direct install by URL                                            |

The default catalog source is the curated **verified** one. Anything you add
under **Sources**, or install by raw URL, is surfaced as **community** and
requires you to acknowledge the risk.

Verified and community services receive the same container sandbox. Verification
is a listing and identity check, not an integrity guarantee about the manifest,
moving image tag, or bytes that will run tomorrow.

## Browsing and installing

Open **Extensions** in the admin panel. It has three tabs:

- **Browse** — cards for every extension in the merged catalog, with search and
  filters by trust tier and component type. Each card shows the trust badge, the
  component types it ships (service / integration), a [service security
  rating](#service-security-rating), and compatibility with your platform
  version. An incompatible, delisted, or security-flagged extension cannot be
  installed.
- **Installed** — what you have installed, each with its components expanded
  (service security rating inline), an **Update** action when a newer version is
  published, and **Uninstall**.
- **Sources** — the catalog sources the Browse list is merged from. The default
  OpenMapX catalog is built in and cannot be removed; you can add your own
  (HTTPS only, no credentials in the URL) and they appear as the **community**
  tier.

Installing from the catalog is one click. To install something not in any
catalog, use **Install from URL** and paste an `extension.json` URL — that always
lands as **community**.

The same operations are available on the CLI:

```bash
pnpm openmapx ext browse                 # list the catalog
pnpm openmapx ext install openconditions # install by catalog id…
pnpm openmapx ext install https://example.com/my-ext/extension.json  # …or by URL
pnpm openmapx ext list                   # what's installed
pnpm openmapx ext update <id>            # re-pin to the latest published version
pnpm openmapx ext remove <id>            # uninstall (removes its services + integrations)
```

The CLI talks to the admin API; run it on the API host (loopback admin) or set
`OPENMAPX_API_URL`. Every install/update/remove is recorded in the audit log.

## What happens on install

Install is one orchestrated, atomic job — it reuses the per-component pipelines
and rolls back on any failure, leaving parts that already existed untouched:

1. **Register + pin each service** — the service repo is shallow-cloned at the
   bundle's pinned tag/commit into `services/.community/<url-hash>/` and marked as
   managed by this extension. Every `service.json` is validated against the
   [service manifest](../developer/service-manifest.md) schema; if any fails, the
   whole install is refused.
2. **Enable + render + start** the service(s) — `compose render` regenerates the
   stack and the container is brought up. Each service creates and migrates its
   own database schema on boot.
3. **Install each integration artifact** — the `.tar.gz` is downloaded
   (HTTPS only), its SHA-256 verified before extraction, unpacked into
   `custom_integrations/<id>/`, and the integration host is hot-reloaded.
4. **Record** the installed extension and its components.

Both on-disk locations (`services/.community/` and `custom_integrations/`) are
gitignored and bind-mounted, so installs survive container restarts.

### The service sandbox

The sandbox is derived from provenance, not the manifest's `quality` label:
manifests loaded from `services/.community/` are third-party whether they say
`community` or `community-verified`. They may **not** use any `bindMounts`
entry: community service installation and updates reject every host bind mount,
including read-only mounts, with `community_bind_mount_forbidden`. Use a
namespaced named volume (`openmapx-<serviceId>-<suffix>`) for persistent service
state instead. They may not use `networkMode: "host"`,
`privileged: true`, host device pass-through, escape-class Linux capabilities
(`SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, and similar), deployment `envFile`, or
Compose-variable bind paths. Network aliases may not collide with another
service id or alias. Operator configuration belongs in
`configSchema`; secret fields are delivered as `/run/secrets/<KEY>` with
`<KEY>_FILE` set. A community Git URL must also be `https://` on a short
allowlist of public hosts (`github.com`, `gitlab.com`, `codeberg.org`,
`bitbucket.org`, `git.sr.ht`) — defense-in-depth so an admin can't coerce a clone
of a `file://`, `ssh://`, or intranet URL into the service tree.

### Service security rating

Each service component shows a deterministic **security rating** (1–8) computed
from what its manifest declares — published host ports lower it, auth-in-front
and an owned (scoped) database schema raise it, and anything requiring built-in
privileges floors it. It's an at-a-glance signal of how contained a service is
_within_ the allowed sandbox; it is not a verdict on the code. Integrations get
no numeric rating because installable integration artifacts are declarative-only;
their companion services use the service rating instead.

### Install-time hardening

Integration artifacts are guarded on several fronts: only HTTPS artifact URLs are
accepted; a SHA-256 pin is mandatory and checked before extraction; artifacts
are capped at 200 MB; tar extraction blocks path-escape (zip-slip), malicious
symlinks/hardlinks, and absolute paths; and an artifact shipping a
`node_modules/` directory is rejected. Backend and frontend runtime
entry points are also rejected; executable behavior must move into an isolated
service. These reduce the blast radius of a
malformed archive — they are not a substitute for trusting the author.

## Updating, uninstalling, and the kill-switch

- **Update** re-pins **all** of a bundle's parts to the latest published version
  through the same orchestrated flow, keeping coupled parts version-consistent.
  The version comes from the extension's own `extension.json` (the manifest the
  catalog points at), not from a number in the catalog — so an extension that
  publishes a moving "latest release" manifest surfaces new releases here
  automatically, and its catalog listing is a one-time inclusion rather than a
  per-release edit.
- **Uninstall** removes exactly what the extension installed — stops and removes
  its service containers, drops the cloned repos and the integrations it placed,
  re-renders compose, and reloads the integration host. Standalone installs of
  the same component are left alone.
- The catalog can carry a **kill-switch**: an extension marked `removed` is hidden
  from Browse (with a banner on installed copies), and one marked `critical`
  shows a blocking security warning on installed copies and refuses new installs.

:::note[An extension-managed service repo is pinned]
Service repos installed as part of an extension are pinned and marked
managed-by-extension. Update them through the extension (which re-pins every part
together), not by hand — a manual refresh of a managed repo is refused to keep
the bundle's coupled parts in agreement.
:::

## Example: OpenConditions

[OpenConditions](https://github.com/openconditions/openconditions) is a
services-only bundle: its **ingest service** (`openconditions-ingest`) polls
road-condition and fuel-price feeds into the shared database and serves them
over HTTP, and its **contributions API** (`openconditions-contributions-api`)
accepts signed crowd reports. The extension ships no integration code. OpenMapX
reads OpenConditions through its built-in `openconditions` integration, which
feeds two things: **roads** (the road-conditions overlay, navigation and
routing closure-avoidance) and **fuel** (the fuel-station layer and its prices;
without OpenConditions the fuel data source is not offered at all). It's
published as the first **verified** entry in the curated catalog, so installing
it is one action:

```bash
pnpm openmapx ext install openconditions
```

The orchestrator registers both services at their pinned tag, renders and starts
them, and reloads the API, all as one job. The install reports success, but
neither service runs yet: both stop at boot and their containers restart in a
loop until their credentials are set (`DATABASE_URL` on both, the grant secret
and reviewer token on the contributions API). Set them as described in
[Configuring the OpenConditions services](#configuring-the-openconditions-services)
and **Save & Apply**; the ingest service then creates its `conditions` schema
and begins ingesting.

### Configuring the OpenConditions services

Both are community services, so OpenMapX passes their manifests'
`container.environment` to the containers verbatim: a `${VAR}` there would reach
the container as literal text, never your `.env`. Everything an operator sets
is a field of the service's `configSchema` instead, managed on
**Admin → Services → `openconditions-ingest`** (and
`openconditions-contributions-api`):

- **Secrets** go on the service's **Credentials** tab. OpenMapX keeps each in
  the credential vault (which needs `OPENMAPX_SECRETS_KEY` on app-api), mounts
  it into the container as a file and sets `<KEY>_FILE` to its path. Secrets
  have no default; the tab marks an unset one **Not set**.
  - `DATABASE_URL` is **required** on both services; they refuse to start
    without it. Set it once to the shared database's full URL, with your
    `POSTGRES_PASSWORD` from `infra/docker/.env`:
    `postgresql://postgres:<POSTGRES_PASSWORD>@postgis:5432/openmapx`.
  - `OPENCONDITIONS_GRANT_SECRET` and `OPENCONDITIONS_REVIEWER_TOKEN` are
    required on the contributions API. Generate each with
    `openssl rand -hex 32`.
  - `OPENCONDITIONS_OPERATOR_TOKEN` (ingest) and every feed's API key are set
    the same way. The token is required for fuel in Germany, Austria and every
    region served only by OpenStreetMap; see
    [the operator token](#the-operator-token) below.
- **Settings** (rate limits, `TRUST_PROXY_CIDRS`, the road-graph `SEGMENT_*`
  and `BIND_*` knobs, `OVERPASS_URL`, `OPENCONDITIONS_EGRESS_ALLOWED_HOSTS`, …)
  carry their defaults in the manifest. Change one in the service's config form,
  or pin it in `infra/docker/.env` as `SERVICE_OPENCONDITIONS_INGEST_<KEY>`
  (`SERVICE_OPENCONDITIONS_CONTRIBUTIONS_API_<KEY>` for the contributions API).
  The env value wins over the form. Pick one place per deployment: a value
  saved in the form survives only renders from the admin panel (and the
  ops-agent), never a `pnpm openmapx services start` from the CLI (see
  [applying a change](#applying-a-change)).

Each OpenConditions service runs on its own isolated network. Four audited
built-ins join it: `postgis`, so both services reach the shared database at
`postgis`; `app-api`, which reads the ingest service and relays crowd reports to
the contributions API; the data-manager, which reads the ingest service's live
traffic; and `overpass`, so the ingest service can query a self-hosted Overpass
at `http://overpass:80`. No other service shares these networks, and OpenMapX
gives a community service no public route, so OpenConditions' public emitter
feeds (GeoJSON, TraFF, DATEX II, the event stream) are reachable only from
inside the deployment. The bridge works both ways: the OpenConditions
containers can also reach `app-api` and the data-manager, including their
internal endpoints. It is granted by service id, so any extension that claims
these ids gets the same reach (see
[the audited exception](../developer/service-manifest.md)).

Then point OpenMapX at the ingest service and the contributions API in
`infra/docker/.env`:

```bash
OPENCONDITIONS_URL=http://openconditions-ingest:4100
# Crowd reports: app-api relays them to the contributions API.
OPENCONDITIONS_CONTRIBUTIONS_URL=http://openconditions-contributions-api:4200
# Required for fuel in DE, AT and the OpenStreetMap-only regions (see below).
# At least 32 characters. Generate with `openssl rand -hex 32`.
OPENCONDITIONS_OPERATOR_TOKEN=
```

#### The operator token

`app-api` and the data-manager's live-traffic cycle send
`OPENCONDITIONS_OPERATOR_TOKEN` as a bearer token, and OpenConditions answers
them in operator scope, which includes the sources it withholds from the
public. A source is withheld (restricted) for one of three reasons:

- **Redistribution not granted.** Tankerkönig (Germany's MTS-K prices) is
  CC BY 4.0, but its terms forbid passing the data to oil companies, station
  operators and the IT providers working for them, which a public API cannot
  rule out.
- **Share-alike.** OpenStreetMap (fuel stations worldwide) is ODbL: a database
  derived from it must be published under the same licence.
- **No licence asserted.** E-Control (Austria's prices) publishes no licence or
  terms for its API.

Some road feeds are restricted for the same reasons. Without the token,
OpenMapX reads in public scope and lists only the public sources: the fuel
layer then shows stations and prices from France (prix-carburants) and Spain
(Minetur) only, and is empty in Germany, Austria and everywhere else. The
withheld sources are not credited, and nothing on the map says why; `app-api`
logs them at debug level.

The token is set in **two places that must hold the same value**: this `.env`
line for `app-api` and the data-manager, and the ingest service's
`OPENCONDITIONS_OPERATOR_TOKEN` credential. The ingest service does not read
OpenMapX's `.env`. A token shorter than 32 characters stops the ingest service
at boot.

The two places fail differently when they disagree:

- **Credential not set** on the ingest service: it has no operator scope and
  logs `operator scope disabled: restricted sources are not served` at startup.
  It answers OpenMapX's bearer requests in public scope: restricted sources are
  withheld, and `app-api` and the data-manager count against the ingest rate
  limit (`RATE_LIMIT_MAX`, 120 requests a minute by default), so a busy
  instance can see 429s that operator scope never gets.
- **Credential set to a different value**: the ingest service answers every
  OpenMapX read with **401**. The road-conditions overlay, closure avoidance,
  fuel search and the live and predicted traffic cycles all stop.

So set the ingest credential first, then the `.env` line, and change both
together when rotating the token.

#### Applying a change

A change takes effect once the stack is re-rendered and the affected
containers are recreated. **Save & Apply** on a service in **Admin → Services**
re-renders the enabled stack from the manifest defaults and the saved
settings, and recreates **that one service**. It never reads
`infra/docker/.env`. It recreates neither `app-api` nor the data-manager, and the admin
panel cannot recreate `app-api` at all: it never starts, stops or recreates
the container it runs in.

`app-api` and the data-manager read `infra/docker/.env` only when their
containers are created, so a change to `OPENCONDITIONS_URL` or
`OPENCONDITIONS_OPERATOR_TOKEN` reaches them only once they are recreated.
After such a change, recreate both from the host, in the repository checkout:

```bash
pnpm openmapx services start app-api data-manager
```

Compose recreates a container whose environment changed, so this replaces
both and leaves the ingest service running as it is. When rotating the token,
**Save & Apply** the ingest credential first, then run the command above.

Where an ingest setting lives decides how you apply it:

- **Saved in the admin form:** **Save & Apply** on `openconditions-ingest`.
- **In `infra/docker/.env` as `SERVICE_OPENCONDITIONS_INGEST_<KEY>`:**
  `pnpm openmapx services start openconditions-ingest`. The admin render
  sees only the variables `app-api` was created with, so a line you add or
  remove counts there only after `app-api` has been recreated.

The CLI renders without database access, so it knows only the manifest
defaults and the environment. A CLI render replaces every setting saved in the
admin form with its default, silently: started from the CLI, the ingest
service would query the public Overpass again and lose its egress allowlist if
those were set in the form. Start `openconditions-ingest` from the CLI only
when its settings live in `infra/docker/.env`.

The ingest service's OpenStreetMap sources (fuel stations) and its road-graph
import query Overpass at its `OVERPASS_URL` setting: either the **base URL**
(for example `http://overpass:80`), to which OpenConditions appends
`/api/interpreter` itself, or the full interpreter URL
(`http://overpass:80/api/interpreter`); a trailing slash is ignored. Its default is the public
`https://overpass-api.de`; OpenMapX's own `OVERPASS_URL` does not reach it. A
self-hosted Overpass on the compose network is a private address, which the
ingest service's egress guard refuses unless its host is listed in the
`OPENCONDITIONS_EGRESS_ALLOWED_HOSTS` setting:

```bash
SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL=http://overpass:80
SERVICE_OPENCONDITIONS_INGEST_OPENCONDITIONS_EGRESS_ALLOWED_HOSTS=overpass
```

For the author-and-operator
walkthrough of how an extension is built and bundled into one `extension.json`,
see [Building an external extension](../developer/building-an-external-extension.md).

## Where to go next

- **[Managing services](../install/managing-services.md)** — enable, render, run,
  and configure any service (built-in or extension-installed) once it's in the
  catalog.
- **[Admin panel](./admin-panel.md)** — where the **Extensions** and **Services**
  sections live, and how admin access works.
- **Developer section** — authoring your own extension, the manifest schemas, the
  `extension.json` bundle format, and the packaging workflow.
