---
title: Architecture
description: The OpenMapX monorepo layout, runtime topology, and the layered mobility data plane.
sidebar_position: 1
---

# Architecture

OpenMapX has two plugin systems: services run backend daemons, and integrations
provide application features. The Compose renderer selects and connects their
containers. This page describes the repository, runtime boundaries, capability
resolution, and mobility data flow.

If you are new to the project, read [How it works](../overview/how-it-works.md)
first. If you operate a deployment, [Managing services](../install/managing-services.md)
is the day-to-day companion to the runtime topology below.

The topology also defines who can see user data. Ordinary synchronized content
is processed by `apps/api` and is not end-to-end encrypted; server-side
credential encryption, TLS, signing, and client encryption are separate
controls. Read the [user-data trust model](./user-data-trust-model.md) before
adding a user-data field, cache, processor, or privacy claim.

## The monorepo

The repository is a [Turborepo](https://turborepo.com/) workspace driven by pnpm.
`pnpm-workspace.yaml` includes `apps/*`, `packages/*`, `integrations/*`,
and `services/data-manager`. `turbo.json` orchestrates build, development, start,
and type-check tasks. Portable tests run through the root Vitest configuration;
the native mobile app has separate Jest/native checks. The Node and pnpm versions are pinned in `.nvmrc` and the root
`package.json`.

```
openmapx/
├── apps/
│   ├── web/                  Next.js 16 frontend (MapLibre GL JS, MUI 9)
│   ├── api/                  Fastify 5 application server + integration host + admin API
│   ├── ops-agent/            private typed operations broker
│   ├── transitous-runner/    isolated Transitous preparation runner
│   └── mobile/               Expo native host for the map and navigation
├── packages/                 shared libraries (see below)
├── integrations/             built-in application features (manifest.json each)
├── services/                 built-in service plugins (service.json each)
│   ├── api/                  manifest for the api image
│   ├── web/                  manifest for the web image
│   ├── data-manager/         data pipeline: source code and manifest
│   ├── transitous-runner/    manifest for the Transitous runner
│   ├── ops-agent/            private deployment manifest for the operations broker
│   └── …                     the optional engines, databases and Traefik
├── infra/docker/             generated output + operator configuration/state
└── docs/                     this documentation site
```

The CLI writes configuration generations (Compose files with release image pins,
and hardlink plans)
under `infra/docker/`. That directory also contains operator input and durable
state, including `.env`, service selection, secrets, and data; it is not a
throwaway build directory. Do not hand-edit generated Compose output.

Installed declarative integration artifacts and community service repositories
live in the operations agent's state, in
`infra/docker/state/ops-agent/custom-integrations/` and
`infra/docker/state/ops-agent/community/`; `api` mounts the first read-only
at `/app/custom_integrations`. Built-in integrations run trusted host code; installed
community integrations cannot load arbitrary JavaScript into the API or web
process. Their executable behavior belongs in separate service containers.

### Applications

| App              | Stack                                                                                   | Responsibility                                                                                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`       | Next.js 16 · React 19 · MapLibre GL JS 6 · MUI 9 · Zustand · TanStack Query · next-intl | The user-facing App Router UI. Layouts and request boundaries use Next.js normally; the interactive map, panels, and navigation shell are client components. The MapLibre instance is shared through React context rather than serialized into application state.                                                                  |
| `apps/api`       | Fastify 5                                                                               | The application server behind `/api`, called directly by the web app, native clients and data-manager. It is _also_ the integration host: it discovers and configures integrations, runs trusted built-ins, hosts declarative community artifacts, resolves service requirements, enforces admin access, and runs background jobs. |
| `apps/ops-agent` | Fastify 5                                                                               | A private, authenticated broker for a closed set of typed Docker and trusted-repository effects. It has no public route, host port, or community network attachment.                                                                                                                                                               |

The web app calls the API for routing and other provider operations. The API
reaches bound engines over the Docker network or uses configured external
providers. Browser map resources can also use public tile/proxy routes shown
below; backend engines do not need public host ports.

The Expo app in `apps/mobile` hosts the web map and native navigation/location
services. `apps/transitous-runner` performs isolated preparation work. See the
[mobile architecture](./mobile-architecture.md) and
[transit integrations](./transit-integrations.md) for their separate execution boundaries.

### Key packages

Shared code lives in `packages/*`. Many packages expose TypeScript source.
Development hosts load or transpile that source; deployment builds may bundle
it. Check each package's exports and scripts before assuming it has a separate
build output. Server code should use focused server-safe entry points instead
of barrels that also export React hooks.

`@openmapx/core` and `@openmapx/mobility-core` declare `sideEffects` in their
manifests, so a bundler drops the modules a page does not use. A module whose
import-time code must run, such as the fetch replacement in `undici-fetch.ts`,
is listed there. `scripts/core-bundle-boundary.test.ts` refuses an unlisted
module with import-time code, classifies every core export as browser, server
or test, and bundles each browser export to prove it reaches no server-only
module.

| Package                                                                                                                                                                                                                                                              | Owns                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@openmapx/core`                                                                                                                                                                                                                                                     | The shared spine: domain types (`Place`, `Route`, geometry, `BBox`), Zustand stores, the typed API client, TanStack Query hooks, the strict ops-agent contract/client, and the **services framework** (manifest schema, registry, the compose renderer, the `DataManagerClient`, capability resolution). |
| `@openmapx/integration-framework`                                                                                                                                                                                                                                    | The manifest schema, registry, loader, the `IntegrationContext` runtime type, and the **typed provider contracts** (one per domain: `TransitProvider`, `RealtimeProvider`, `MobilityDataSourceProvider`, `GeocodingProvider`, `RoutingProvider`, `WeatherProvider`, and more).                           |
| `@openmapx/mobility-formats`                                                                                                                                                                                                                                         | Pure, stateless parsers over raw bytes: GTFS, GTFS-RT, GBFS, GOFS, SIRI, OJP, CSV. No I/O, no policy.                                                                                                                                                                                                    |
| `@openmapx/mobility-formats-tomp`                                                                                                                                                                                                                                    | The TOMP-API (OpenAPI-generated) client, split out so its codegen dependencies don't bleed into every bundle that touches the other formats.                                                                                                                                                             |
| `@openmapx/mobility-core`                                                                                                                                                                                                                                            | The canonical mobility model: one entity type per domain, plus `Attribution`, `Freshness`, `MobilityResult<T>`, the TTL/dedup policy constants, and the GBFS client.                                                                                                                                     |
| `@openmapx/db-schema`                                                                                                                                                                                                                                                | Drizzle ORM table definitions shared between `apps/api` and `services/data-manager` (job tables, feed state, provider health).                                                                                                                                                                           |
| `@openmapx/cli`                                                                                                                                                                                                                                                      | The `openmapx` operator command line: services, compose, data, integrations/extensions, users, backups, cache, Transitous, and diagnostic checks.                                                                                                                                                        |
| `@openmapx/i18n`                                                                                                                                                                                                                                                     | Locale JSON for `en` and `de`, plus a `check-translations` gate that fails CI when locales drift. Consumed by `apps/web` (next-intl) and `apps/api` (integration string lookups).                                                                                                                        |
| `@openmapx/presets`                                                                                                                                                                                                                                                  | OSM preset matching and category chips, built on iD's tagging schema.                                                                                                                                                                                                                                    |
| `@openmapx/ev-charge-planner`                                                                                                                                                                                                                                        | Pure EV trip planning: vehicle energy models, charge curves, corridor candidates, matrix scoring, network/availability/tariff policy, and itinerary estimates.                                                                                                                                           |
| `@openmapx/extension-cli`                                                                                                                                                                                                                                            | Community-extension manifest/service scaffolding, validation, and declarative packaging. Executable behavior belongs in an isolated service container.                                                                                                                                                   |
| `@openmapx/openconditions-contrib-client`                                                                                                                                                                                                                            | Browser-side device keys, structural validation and RFC 8785/ES256 signing of OpenConditions situation and observation claims, and signed votes on records for crowd reports.                                                                                                                            |
| `@openmapx/transitous-core`                                                                                                                                                                                                                                          | Shared Transitous catalog normalization and feed-selection logic used by the CLI, API, and data pipeline.                                                                                                                                                                                                |
| `@openmapx/place-ids`, `@openmapx/mangrove-client`, `@openmapx/mangrove-react`, `@openmapx/command-palette`, `@openmapx/noaa-coops-data`, `@openmapx/ourairports-data`, `@openmapx/hardlinks`, `@openmapx/motis-feed-proxy-config`, `@openmapx/hey-api-client-fetch` | Focused utilities: stable place identifiers, Mangrove review signing, the search palette, bundled open datasets (tide stations, airports), the local hardlink applier, the MOTIS feed-proxy nginx config renderer, and the workspace fetch runtime used by generated API clients.                        |

## Runtime topology

A deployment connects selected Docker containers through the generated network
configuration. Community services have a separate network boundary and receive
only the access declared by reviewed service contracts. The
[overview diagram](../overview/how-it-works.md#a-deployment-at-a-glance) shows
the shape; here is what each tier is actually doing.

<div className="docs-diagram" style={{"--diagram-min-width": "118rem"}} tabIndex={0} role="region" aria-label="Runtime topology diagram">

```mermaid
graph TD
    accTitle: Runtime topology
    accDescr: Traefik routes requests to application services. The API uses integration registries, domain orchestrators, local engines and infrastructure; typed operations isolate host authority in the ops-agent.
    Internet((Internet)) -->|443| Traefik["traefik · TLS termination"]

    Traefik -->|/| Web["web · Next.js"]
    Traefik -->|/api| API["api · Fastify"]
    Traefik -->|/tiles · /martin| Tiles["tileserver · martin"]
    Traefik -->|/.well-known| WK["well-known"]

    Web -->|REST| API

    subgraph Host["api: the integration host"]
      direction LR
      IH["Integration registry<br/>+ service registry<br/>+ capability bindings"]
      Orc["Domain orchestrators<br/>geocoding · routing · transit · …"]
      Jobs["Job runner"]
    end

    API --> Host

    Orc -->|capability bindings| Engines
    subgraph Engines["Backend engines (opt-in)"]
      Routing["valhalla · osrm"]
      Transit["motis · otp"]
      Geocoding["photon · nominatim · pelias"]
      Queries["overpass"]
    end

    subgraph Infra["Always-on core"]
      PG[("postgis<br/>application + operational metadata<br/>no GTFS schedules")]
      Cache[("redis / valkey")]
      DM["data-manager"]
      Ops["ops-agent · private typed broker"]
    end

    API --> PG
    API --> Cache
    API -.->|authenticated typed effects| Ops
    DM -.->|authenticated typed effects| Ops
    Jobs -.->|start/stop/restart| Engines
    DM -.->|OSM · fonts · promoted MOTIS datasets| Engines
```

</div>

Traefik terminates TLS for the bundled proxy deployment. An operator can
configure an external proxy instead. Containers address bound services by
their project-unique name `openmapx-<service-id>`, for example
`http://openmapx-valhalla:8002`, never by the bare service ID: behind an
external proxy, routed services also join the proxy's shared network, where a
bare ID could resolve to another project's container. A manifest can expose a proxy
route through `exposure.proxy` or bind a host port through `exposure.hostPorts`
(loopback by default). Inspect those declarations when reviewing network access.
`web` claims `/` at the lowest proxy priority; more specific routes such as
`/api`, `/tiles`, `/martin`, and `/.well-known` take precedence.

**The always-on core.** A handful of services are selected by default:
`traefik`, `well-known`, `api`, `web`, `postgis`, `redis`, `data-manager`,
and `ops-agent`. Everything heavy (routing engines, geocoders, transit engines,
the Overpass server, tile servers) is opt-in: you add it to the _selection_ and
re-render. PostGIS is the system of record for application data and operational
pipeline metadata; it does not store GTFS schedules. Redis (Valkey) is the
cache.

**The private operations boundary.** `ops-agent` accepts only versioned,
short-lived requests from `api` or `data-manager`, authenticated with
distinct file-mounted bearer credentials. Its contract is a strict
discriminated union: callers cannot supply a command, arbitrary arguments,
Compose/YAML, environment maps, caller paths, or container names. The agent
maps authorized operation kinds to fixed runtime adapters and emits only
bounded structured audit fields. It is reachable solely on the private
`openmapx` network.

`ops-agent` is the sole owner of the Docker socket and trusted repository write
mounts, including its stores of community service checkouts and installed
integrations. `api` and `data-manager` submit typed operations instead of receiving
that host authority themselves. The agent's own state (job journal and the
prepared configuration candidates the API hands it) lives
in `infra/docker/state/ops-agent/`, outside the data directory data-manager
mounts; `api` mounts only the integration store, read-only, and
`pnpm check-ops-authority` keeps it that way. A configuration apply carries its
payload in the authenticated request, named in the operation by its digest; the
agent's journal keeps the digest, never the payload. `api` reads the release and active Transitous pins through the
read-only `transitousPin.inspect` operation. The proposal and every change stay
`data-manager`'s operations, which the admin panel's bump goes through. The built-in service manifests the agent and its
fixed CLI render come from the agent's own image, not from the host checkout.
A process cannot recreate its own container, so
to update itself the agent starts a short-lived helper container from its own
image. The helper has only the socket and the agent's own mounts at the
checkout's path, no network and no capabilities. It replaces the agent
container from the applied generation, verifies the new agent and exits.

The agent has one mount layout, the one its manifest declares, at the same
host paths as outside it, because Compose's bind sources must resolve the same
inside and outside it: `infra/docker` read-only (for `.env`, through the
directory so an editor's atomic save is seen, and the overrides) and
`infra/docker/state`, `data`, `secrets`, `backups` and `catalog-pins`
read-write. It never has the checkout: everything it needs comes from its
image and its state. CI runs the agent's image with these mounts (`test (ops-agent image)`),
and the install smoke check requires the running agent to mount nothing at the
checkout's root. Traefik consumes generated configuration rather than
discovering containers through the Docker socket, so there is no duplicate
host-control path outside the broker.

`api` runs the integration host alongside core routes, service discovery,
and asynchronous jobs:

- Static routes registered directly on Fastify: `/health`, `/api/places`,
  `/api/isochrone`, `/api/tiles/*`, `/api/admin/*`, and so on.
- The **integration host**, which loads every trusted built-in integration's `setup(ctx)` and
  exposes their HTTP routes through a single dispatcher (more on this below).
- The **service registry**, which validates `service.json` manifests and answers
  "what's installed, what does it provide, what URL is it on."
- The job runner tracks service lifecycle operations, data preparation, and
  community installs in the same process but off the request path. It hands
  host effects to the operations agent and data work to data-manager. The admin
  UI polls its progress.

A global `onRequest` hook applies tiered, IP-keyed rate limits. It classifies
each request by the route template Fastify matched, not the raw URL, so an
encoded spelling of a path lands in the same tier as the plain one, and a
request that matches no route has its own small bucket rather than none. Keys
reduce an IPv6 client to its /64 and an IPv4-mapped address to its IPv4 form,
and each limiter keeps a bounded number of buckets. Admin route
scopes also enforce administrator authorization through their runtime guards. Fastify trusts
forwarding headers only when the socket peer belongs to an explicitly configured
proxy IP/CIDR range, so limiters and the audit log see the real client IP without
accepting headers from a directly connected client. The loopback admin
short-circuit deliberately reads the raw socket address, so a forged
`X-Forwarded-For` can't bypass it.

**The data plane behind the engines.** The `data-manager` service owns the
`/data` tree. It downloads OSM extracts and map glyphs, and runs the
transactional Transitous/operator-source pipeline that imports candidate static
schedules into an inactive MOTIS slot. OTP remains a separately configured
regional transit alternative with its own graph build. The data-manager
promotes a complete MOTIS candidate only after its
functional probes pass, so requested and active source state may differ and a
failed job preserves the prior live dataset. Shared artifacts are _hardlinked_
into consumer directories so several engines can use one multi-gigabyte file without another full copy on the same filesystem. The compose renderer plans those links from each service's
`consumes:`/`produces:` declarations; `data-manager` applies the plan. See
[Managing services](../install/managing-services.md) for the operator workflow.

Beyond downloads and transit, data-manager builds the PostGIS place and search
indexes (Overture places, the OSM search index, notable and ambient places),
runs the live and predicted traffic loops that feed Valhalla, generates and
serves offline map packages, and reports data coverage. Every host effect it
needs, such as restarting MOTIS or reloading the feed proxy, is a typed
operation the operations agent performs; data-manager holds no Docker socket.

## The capability model

Services and integrations never name each other directly when they can avoid it.
Instead they meet through **capabilities**: free-form strings like
`routing-engine`, `geocoder`, `transit-engine`, `tile-server`, `osm-query`.

<div className="docs-diagram" style={{"--diagram-min-width": "72rem"}} tabIndex={0} role="region" aria-label="Capability binding diagram">

```mermaid
graph LR
    accTitle: Capability binding
    accDescr: The routing integration requires a routing-engine capability. An operator binding selects Valhalla or OSRM as the service that supplies it.
    subgraph I["Integration (requires)"]
      R["routing orchestrator<br/>requires: capability routing-engine"]
    end
    subgraph S["Services (provide)"]
      V["valhalla<br/>provides: routing-engine"]
      O["osrm<br/>provides: routing-engine"]
    end
    B{{"capability_binding<br/>(operator choice)"}}
    R -.->|asks for routing-engine| B
    B -->|resolves to| V
    B -.->|or| O
```

</div>

- A **service** declares what it offers with `provides: [...]`.
- An **integration** declares what it needs with `requires: [...]`, either by
  capability (`{ "capability": "geocoder" }`) or by a specific service id
  (`{ "service": "valhalla" }`), and may mark a requirement `optional`.
- A **binding** resolves the two. When exactly one installed service satisfies a
  capability, the host auto-selects it. When several do, an operator picks one in
  the admin panel; that choice is stored in the `capability_binding` table and
  consulted at host startup. An unmet `optional` requirement falls through to the
  integration's own public-API fallback (for example, the routing orchestrator
  reaches the public Valhalla endpoint when no local router is bound).

Operators select a service that implements the required capability without
changing the consumer. Provider-specific capability limits and configuration
still apply.

### Domains and orchestrators

Every integration registers into one or more **domains**: `geocoding`,
`routing`, `transit`, `live-transit`, `data-source`, `poi-search`, `search-suggestions`, `photos`,
`reviews`, `weather`, `knowledge`, `map-overlay`, `street-level-imagery`,
`road-conditions`, `gtfs-catalog`. Domains with multiple providers use an **orchestrator integration** (`integrations/geocoding/`,
`integrations/routing/`, `integrations/transit/`, and so on) that owns the
domain's public API routes and a registry of providers. Provider integrations
declare a dependency on their orchestrator, so the host's topological sort always
loads orchestrators first.

The orchestrator's job is to merge across providers, and the strategy varies by
domain: geocoding and weather run a **fallback chain** (first non-empty wins);
data-source, photos, reviews, and poi-search **merge everything**; transit
**fans out and deduplicates** across providers matched by coverage box and
prefix; map overlays are **independent layers**. The transit orchestrator is the
most involved: it routes id-bearing requests by provider prefix (`bvg:`, `mo:`,
`g-<slug>:`), waterfalls trip-planning by priority, fans stops and alerts out in
parallel, and deduplicates overlapping results.

`search-suggestions` is a concurrent merge domain for exact place codes,
explicit aliases/references, and conservative acronyms. Its provider contract
returns normalized match evidence, stable/cross-source identifiers,
importance, and per-result attribution. The built-in providers adapt
OurAirports, the configured transit orchestrator, and the independently built
`osm_search` and `notable_places` PostGIS schemas. The second holds places
covered by many Wikipedias, with a `fame` value the ranker takes at face value,
so far-away landmarks outrank nearby namesakes whatever geocoder runs. This
domain deliberately does not replace the
geocoding fallback chain; `SearchBar` merges both responses after each has
applied its own semantics.

The client merge in `packages/core/src/search/searchSuggestion.ts` gives exact
result IDs and shared external identities precedence over spatial heuristics.
Ordinary POIs require independent source-record namespaces, equivalent concrete
address context and compatible category/entity evidence; same name and proximity
alone must not erase separate branches or tenants. Manifest `sourceIds` are
attribution only. City, transit and landmark reconciliation remain entity-specific.
The [search policy](../features/search.md#keeping-distinct-places-in-the-list)
documents the fallback's conservative address limits and source-identity rules.

The OSM alias index is an ODbL-derived data product owned by `data-manager`.
The manager streams a selected PBF through Osmium into an
`osm_search__staging` schema, validates it, and atomically swaps it into
`osm_search`. Publication epochs invalidate provider caches without key scans,
and a failed rebuild leaves the previous live schema queryable. The
`notable_places` schema follows the same staging-and-swap pattern, filled from
a Wikidata SPARQL endpoint (CC0) instead of a PBF, and so does Overture's
`overture_places`.

A publication never makes the API's readers wait
(`services/data-manager/src/jobs/publish-schema-swap.ts`). Indexes and
`ANALYZE` run on the staging schema first. One transaction then renames the
live schema to `<live>__previous` and the staging schema to the live name.
Renaming a schema takes no table lock, so it commits at once, and every later
query resolves the live name to the new tables, prepared statements included.
A second transaction drops `<live>__previous` once its last reader, such as a
running backup, has finished. Each step waits at most one second for a lock and
is retried with growing pauses. The publication has committed by then, so if
the drop fails, for example because the old schema is still being read after
the last retry, the schema stays in place, the failure is only logged, and the
next publication drops it before it swaps. Overture's OSM POI snapshot and its
conflation links are swapped the same way as single tables inside
`overture_places`: renaming a table does take its lock, so those swaps wait for
that table's readers, a second at a time. The conflation run is marked complete
in the links' swap transaction, because the next-link table is empty after the
swap and must never be published again.

Points in these schemas are `geometry(Point, 4326)` columns with a GiST index,
so bounding-box and nearest-neighbour queries use the index; readers take
coordinates with `ST_X`/`ST_Y` and measure distances by casting to
`geography`. H3 cells are stored as `bigint`: a cell index's top bit is
reserved and always 0, so the value fits, and data-manager converts at the
database boundary from and to the hexadecimal form h3-js uses. Indexes and
constraints are named `<table>_<columns>_<kind>`
(`idx`, `key`, `pkey`, `fkey` or `check`), which lets a table swap rename them
together with their table.

## The integration host lifecycle

When `apps/api` boots, the host runs the same sequence it re-runs on every hot
reload:

<div className="docs-diagram" style={{"--diagram-min-width": "84rem"}} tabIndex={0} role="region" aria-label="Integration host lifecycle diagram">

```mermaid
graph LR
    accTitle: Integration host lifecycle
    accDescr: The host discovers and validates manifests, sorts dependencies, resolves configuration and services, calls setup, and seeds health state.
    D[Discover] --> V[Validate] --> T[Topological sort] --> C[Resolve config]
    C --> Rq[Resolve requires] --> Su["setup(ctx)"] --> H[Seed health]
```

</div>

1. Discover: scan `integrations/` and the installed integrations (mounted at
   `custom_integrations/`) for `manifest.json`.
2. Validate: apply the manifest schema and business rules. Invalid manifests
   are skipped with a warning. Required host configuration can still fail
   startup, including a missing or unusable secrets key for discovered
   integrations that declare vault-backed secrets.
3. Topological sort: order by each manifest's `dependencies:` so
   orchestrators load before their providers.
4. Resolve config: a five-layer cascade, highest wins: environment variable
   → local `config.json` → encrypted vault → database (admin UI) → schema
   default.
5. Resolve `requires:`: match each integration's requirements against the
   service registry and the capability bindings.
6. `setup(ctx)`: call every enabled built-in integration with a rich
   `IntegrationContext`. Through `ctx`, an integration registers providers
   (`ctx.registerTransitProvider`, `ctx.registerMobilityDataSource`,
   `ctx.registerProvider(domain, …)` for the rest), mounts HTTP routes
   (`ctx.registerRoute`), and reaches its cache, logger, secrets, and bound
   services.
7. Seed health: an initial health sweep runs ~5 s after startup and ticks every
   60 s, running each check on its own cadence (1 m local/self-hosted, 15 m
   external, 30 m keyed external, with exponential retry backoff on failure) and
   populating the per-integration health the admin panel surfaces.

Integration HTTP routes are not registered as individual Fastify routes. They go
into one in-memory table that a single catch-all dispatcher consults, so a host reload can replace that table, rediscover manifests, resolve
bindings, and rerun setup without restarting the API.
`POST /api/integrations/reload` is registered only outside production;
production administration uses the authenticated integration lifecycle operations.

:::note[Production vs. development reload]
The host adds the backend entry file's mtime and size to its import URL in both
development and production. A changed entry can reload; unchanged entries reuse
Node's cached module. This does not invalidate unchanged URLs for transitive
imports. Restart `api` after changing already-loaded built-in code when a
reload cannot replace the complete module graph. Installed declarative artifacts
have their own reload lifecycle and do not execute a `setup()` module in the host.
:::

## The mobility data plane

Transit, shared mobility, parking, fuel, and EV charging use shared parsers,
canonical models, and typed provider contracts. Parsers
decode bytes; models define results and policy; integrations acquire and serve
evidence. Keep I/O and provider policy out of the parser layer.

<div className="docs-diagram" style={{"--diagram-min-width": "24rem"}} tabIndex={0} role="region" aria-label="Mobility data flow diagram">

```mermaid
graph TD
    accTitle: Mobility data flow
    accDescr: Raw feed bytes enter pure format parsers, then canonical mobility models, then typed integration providers, and finally domain orchestrators, API and web views.
    Bytes[/"raw bytes from a feed or API"/] --> F
    subgraph F["1 · @openmapx/mobility-formats"]
      F1["pure parsers: GTFS · GTFS-RT · GBFS · GOFS<br/>SIRI · OJP · CSV<br/>no I/O · no policy"]
    end
    F -->|typed rows| MC
    subgraph MC["2 · @openmapx/mobility-core"]
      MC1["canonical model: one entity per domain<br/>+ Attribution · Freshness · MobilityResult&lt;T&gt;<br/>+ TTL / dedup policy constants"]
    end
    MC -->|MobilityResult&lt;T&gt;| INT
    subgraph INT["3 · integrations/ + integration-framework contracts"]
      INT1["typed providers: TransitProvider ·<br/>RealtimeProvider · MobilityDataSourceProvider<br/>declare coverage · priority · attribution"]
    end
    INT -->|merged result| Orc["domain orchestrator → API → web"]
```

</div>

**Layer 1: formats (`@openmapx/mobility-formats`).** Stateless functions over
bytes. `parseGtfsRealtime(bytes)` returns a typed feed message;
`parseSiri(xml)` decodes the envelope and a `siri-transit` companion normalizes
it toward the canonical model. These functions perform no network I/O or caching
and apply no provider policy. Request-path providers and offline validators can
reuse the same byte-to-row decoding. TOMP lives in the
sibling `mobility-formats-tomp` package only because its OpenAPI codegen pulls in
heavy dependencies that shouldn't ride along with the lean parsers.

**Layer 2: canonical model (`@openmapx/mobility-core`).** One TypeScript type
per domain entity (transit, shared-mobility, parking, fuel, EV-charging), one
`Attribution` shape, one `Freshness` envelope, and one wrapper that every
provider returns:

```ts
interface MobilityResult<T> {
  data: T;
  attributions: Attribution[];
  freshness: Freshness;
}
```

Because `Attribution` and `Freshness` are defined once, the orchestrator can
merge and deduplicate provider attributions while preserving contributor
precedence. The UI renders retained sources through shared attribution helpers.
Providers must still capture the correct receipts, and views must project only
the items and fields they display. The TTL and dedup _policy_ (cache
lifetimes per data class, dedup radii, name-similarity thresholds) lives in one
`policy.ts`, so cache and deduplication behavior is consistent across every
mobility domain rather than reinvented per integration. This layer also carries
the GBFS client and station resolver that shared-mobility providers build on.

**Layer 3: providers (`integrations/*`).** A concrete provider implements one
of the typed contracts in `@openmapx/integration-framework/src/contracts/`:
`TransitProvider` (stops, departures, planning, alerts, with a capability bitmap
so the orchestrator dispatches by declared capability rather than reflection),
`RealtimeProvider` (vehicle positions, trip updates, situation feeds), or
`MobilityDataSourceProvider` (bike/scooter/car-sharing). Parking, fuel, EV
charging, and webcams read OpenConditions through the typed `ParkingSiteProvider`,
`FuelStationProvider`, `ChargingSiteProvider`, and `CameraProvider` contracts. Each provider declares its coverage box, priority, and a static
`attribution`, and returns `MobilityResult<T>`. The orchestrator dispatches on
capability, coverage, and current health.

### Why split it this way

A shared parser fixes decoding for all consumers. Canonical models let
orchestrators combine providers without redefining each entity. Required
attribution and freshness fields keep those obligations at the provider boundary.
A new mobility provider should implement the existing contract and reuse the
shared parsers and model.

The same `MobilityResult<T>` discipline does **not** extend to the non-mobility
domains (geocoding, routing, weather, reviews, photos, knowledge), which still
have domain-specific provider contracts registered through
`ctx.registerProvider(domain, …)`. Their orchestrators own the merge semantics.
Air quality has a separate canonical evidence/standards model in
`@openmapx/air-quality`; see the [provider guide](./air-quality-integrations.md).

### Bulk datasets live in OpenConditions

Registries too large to fetch per request (national EV-charging, parking, fuel
and traffic-camera registers) and the hazard feeds (weather alerts, fire
detections, earthquakes, natural events) are not ingested by OpenMapX.
OpenConditions fetches, parses and links them, and OpenMapX's orchestrators read
the result through the `charging-sites`, `parking-sites`, `fuel-stations`,
`cameras` and `hazards` providers, so bulk datasets present the same canonical
shape as every other source.

## Where to go next

- [Integration system](./integration-system.md): the manifest, the
  `IntegrationContext`, domains, and config resolution in depth.
- [Service manifest](./service-manifest.md): the `service.json` schema,
  capabilities, exposure, and data sharing.
- [Writing an integration](./writing-an-integration.md): build a provider
  end to end.
- [CLI reference](./cli-reference.md): every `openmapx` command.
- [Development setup](./development-setup.md): run the stack locally.
