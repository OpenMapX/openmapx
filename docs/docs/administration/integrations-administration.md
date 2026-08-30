---
title: Integrations & bindings
description: Configure integrations through the layered config cascade, set secrets, choose capability bindings, and check integration health.
sidebar_position: 3
---

# Integrations & capability bindings

An **integration** is an app-level feature — the geocoding orchestrator, the
routing orchestrator, a transit provider, a map overlay, an external data
source, photos, reviews, place enrichment. Each one ships a `manifest.json` that
declares its config schema, the secrets it needs, and the backend services it
requires. The admin panel under `/admin/integrations` is where you turn those
declarations into a working configuration: enable the features you want, fill in
their settings and credentials, and — when a feature needs a backend that more
than one service can supply — pick which one it uses.

If the service/integration/capability model is new to you, read
[How it works](../overview/how-it-works.md) first. This page assumes it and
focuses on the admin side. The panel and the API behind it are mapped in the
[Admin panel tour](./admin-panel.md); installing third-party integrations is
covered in [Community extensions](./community-extensions.md).

Community integrations — such as the OpenConditions road-conditions provider —
configure, bind, and probe exactly like the built-in ones described here once
installed; see [Community extensions](./community-extensions.md) for how to
install them.

## The integration list

`/admin/integrations` lists every loaded integration with its display name, the
domains it serves, whether it's enabled, its health, and whether its credentials
and required services are satisfied. Click into one to open its detail page,
which is organized into tabs:

- **Overview** — metadata, the services and other integrations it depends on,
  and the capability-binding picker.
- **Config** — the per-integration settings form, plus a read-only table showing
  every resolved value and where it came from.
- **Credentials** — the secret fields the integration declares, and their status.
- **Health** — the current probe result, with a button to re-run it.

Two controls sit outside the tabs. An **enable / disable** toggle flips whether
the integration loads at all, and a **Reload** action re-runs the integration's
setup so a config or binding change takes effect. Reload is queued as a
background job — watch it finish under the panel's Activity view
([Monitoring](./monitoring.md)).

## Configuring an integration

If an integration's manifest declares a `configSchema`, the **Config** tab
renders it as a form: one input per setting, typed from the schema — toggles for
booleans, dropdowns for enumerations, text and number inputs otherwise. An
integration with no schema (or one that exposes nothing beyond the on/off
switch) shows a note instead.

Saving writes your edits to the database and reloads the integration so the new
values apply right away — there's no separate restart step for integration
config, unlike backend services. The form rejects unknown keys and type
mismatches against the schema, and it refuses two kinds of field: secret fields
(those go through the Credentials tab) and the `enabled` switch (use the
enable / disable toggle). Every change is written to the audit log.

### The config cascade

Each setting's effective value is resolved through a layered cascade. The
**Config** tab shows a `source` chip next to every field naming the layer that
won, and a field pinned by an environment variable is rendered **disabled** —
you can see the value but not edit it, because the environment would override
your edit anyway.

There are five layers. Highest priority wins:

| Priority | Source        | Where it comes from                                                    |
| :------: | ------------- | --------------------------------------------------------------------- |
|    5     | `env`         | A host environment variable, `INTEGRATION_<ID>_<KEY>`.                 |
|    4     | `config.json` | A `config.json` file in the integration's own directory.              |
|    3     | `vault`       | An admin-set secret in the encrypted vault.                           |
|    2     | `database`    | A value you saved in the Config form.                                  |
|    1     | `default`     | The `configSchema` default — nothing has overridden it.               |

So an environment variable beats a local `config.json`, which beats a vaulted
secret, which beats a value saved in the admin panel, which beats the schema
default. Environment variables always win, which keeps a Docker deployment
predictable: a value pinned in `infra/docker/.env` can't be silently changed
from the UI, and the disabled field plus its `env` chip make that visible.

:::note[Why a saved value sometimes "won't stick"]
If you save a field in the form and it doesn't change, look at its source chip.
A higher layer — almost always an `env` override in `infra/docker/.env` — is
taking precedence. Remove that override (or change it there) to let the admin
value through. The same logic governs every layer of the cascade.
:::

The environment-variable name follows a fixed pattern: `INTEGRATION_`, then the
integration's id, then `_`, then the config key — both the id and the key are
hyphen-normalized (hyphens become underscores) and upper-cased. A camelCase
schema key like `apiKey` has no hyphens to normalize, so it is set by
`INTEGRATION_<ID>_APIKEY`:

```bash
# infra/docker/.env — overrides the `apiKey` setting of the `geocoding-maptiler` integration
INTEGRATION_GEOCODING_MAPTILER_APIKEY=your-key-here
```

Region-first hyphenated keys are normalized the same way. For example, the
`de-tankerkoenig-api-key` config key of the `fuel` integration is set by:

```bash
# infra/docker/.env — overrides the `de-tankerkoenig-api-key` setting of the `fuel` integration
INTEGRATION_FUEL_DE_TANKERKOENIG_API_KEY=your-key-here
```

For the bigger picture of where settings live — `.env`, the admin panel, and how
they relate — see [Configuration](../install/configuration.md). The parallel
cascade for *backend services* uses the `SERVICE_<ID>_<KEY>` prefix and only
three layers; see [Managing services](../install/managing-services.md).

### Secrets

A config field marked `"x-openmapx-secret": true` in the manifest is a secret —
an API key, a token, a password. Secrets are never shown in the Config form or
returned in API responses; they live on the **Credentials** tab instead, where
each declared secret is listed with its status: stored in the **vault**,
supplied by an **env** override, or **missing**.

Set or rotate a secret from that tab. Its value is encrypted at rest in the
database vault, which requires `OPENMAPX_SECRETS_KEY` to be set on the API host
(generate one with `openssl rand -hex 32`). Without that key the vault is
unavailable and the panel says so; an integration that *declares* secret fields
will refuse to load at startup until the key is present, so this is a hard
requirement rather than a silent degrade.

You can also supply a secret entirely through the environment, with the same
`INTEGRATION_<ID>_<KEY>` variable used for any other setting — handy when you'd
rather keep credentials in `infra/docker/.env` than in the database. As always,
the env value wins over a vaulted one. An integration whose every required
secret is still missing is flagged as unconfigured in the list and on the
Overview dashboard.

Where an integration's manifest provides it, each credential also shows a short
**setup guide** inline — a "Get API key" button linking straight to the
provider's registration page, an optional pre-filled request email for providers
that grant access by hand, a free-tier/pricing hint, and a collapsible list of
steps to obtain the value. It appears next to the field on the Credentials tab,
on the bulk-configure page, and in the Set-credential dialog, so you rarely need
to leave the panel to hunt down where a key comes from.

## Capability bindings

Integrations don't name a specific backend; they ask for a **capability**. The
routing integration requires a `routing-engine`; the geocoding providers require
a `geocoder`. Whether that capability is satisfied by Valhalla or OSRM, Photon or
Nominatim, is a deployment choice — and when more than one installed service can
satisfy a requirement, you choose which one, by setting a **binding**.

How a requirement resolves at load time:

- **A `service:` requirement** names one specific service. It's satisfied if that
  service is installed and enabled — no choice to make.
- **A `capability:` requirement with exactly one provider** is auto-selected.
  Nothing to do; the single matching service is used.
- **A `capability:` requirement with multiple providers** is *ambiguous*. The
  integration won't resolve that requirement until you pick a binding — until
  then it logs a warning and the requirement is left unsatisfied.
- **An optional requirement** with no provider falls back to the integration's
  public default (for example, a public routing endpoint) rather than failing.

You choose a binding on the integration's **Overview** tab. Each `capability:`
requirement shows a dropdown listing every installed service that provides it;
pick one to bind it, or choose *(none — use fallback)* to clear the binding and
let auto-select or the public fallback take over. The picker only offers
services that genuinely provide the capability — a service that doesn't is
rejected.

A binding is a stored `(integration, capability) → service` mapping. The
integration host loads all bindings once at startup and re-reads them on reload,
so after changing a binding, reload the integration (or restart the API) for it
to take effect. Like every admin action, setting a binding is audit-logged.

:::note[Bindings are per integration, not global]
The same capability can be bound to different services for different
integrations. Binding is also the *only* step you take in the panel — you still
[enable the backing service](./services-administration.md) and render the stack
separately; the binding just tells the integration which of the running
providers to call.
:::

## Integration health

An integration whose manifest declares a `healthCheck` is probed periodically,
and the result drives the status shown in the list, on the **Health** tab, and on
the Overview dashboard. The host seeds the checks shortly after boot and refreshes
them in the background; the Health tab also has a button to run the probe on
demand.

A check resolves to one of three states:

- **up** — the probe succeeded.
- **down** — the probe failed (connection refused, a timeout, an HTTP error);
  the last error is shown.
- **unconfigured** — a required config key or secret is unset, or a self-hosted
  service the check points at isn't enabled. This is treated as "not set up yet,"
  not a failure, so a feature you haven't configured doesn't show up as broken.

An integration with no health check is simply assumed healthy. Some integrations
run several sub-checks (for example, one per country or per upstream); those
roll up into a single signal — any sub-check down makes the integration down,
otherwise any up makes it up. Probe history is retained, so the
[Monitoring](./monitoring.md) view can show trends rather than just the current
state.

:::note[Health checks must target public hosts]
The integration-health endpoint can be reached anonymously, so a manifest's
`healthCheck` URL or TCP target must resolve to a public host. A check pointed at
a loopback, link-local, or private-range address (`127.0.0.1`, `169.254.169.254`,
…) is rejected and reported as down. Built-in `service:` targets are exempt —
they're meant to be internal.
:::

## Data-use policy

Some data sources carry licence terms a commercial deployment may not be able to
honour. Each source declares a `commercialUse` stance in its manifest, and
OpenMapX lets an operator gate the two restrictive classes:

- **Non-commercial sources** (`commercialUse: "no"`) — for example Open-Meteo's
  free tier.
- **Grey-area sources** (`commercialUse: "unknown"`) — public APIs whose terms
  are merely undocumented.

Both are **allowed by default**, since the project's reference deployment is
non-commercial. A commercial operator can disallow either class from
`/admin/settings`, or with the `OPENMAPX_ALLOW_NONCOMMERCIAL` /
`OPENMAPX_ALLOW_GREY_AREA` environment variables (env wins over the panel, and a
change takes effect immediately). When a class is disallowed, orchestrators skip
the affected providers and a response filter strips any data that came solely
from a gated source — so a gated source is never queried and never reaches the
map.

:::note[Disclosure tables still list every source]
Disabling a source removes its *data* from results, but the `/privacy` and
`/terms` source-disclosure tables continue to list every source the build ships,
so the published licence and privacy metadata stays complete.
:::

## Upstream cache and provider circuits

Quota-bound integrations use the shared Redis/Valkey upstream runtime. Cache
records distinguish a fresh interval, a soft-stale interval that may be served
while one lease holder refreshes, and a hard-stale interval usable only after a
refresh error. None of these cache timestamps changes the observation or
publication time shown to users. Refresh leases use owner-only release, and
minute/hour quota windows are consumed in one atomic transaction.

Production quota refresh is fail-closed when Redis is unavailable: the API may
serve eligible stale evidence, but it does not start an uncoordinated refresh or
guess at remaining quota. Operator logs report `store_unavailable`, corrupt
records are discarded, and cache keys hash coordinate-derived material.

Provider circuits have `healthy`, `degraded`, and `open` states. Two consecutive
counted failures or a 25% recent failure rate degrades a provider; five
consecutive failures or a failure rate above 50% opens it. Cooldowns increase
through 5, 10, 20, 40, and 60 minutes. Exactly one process owns the half-open
probe. Timeouts, connection errors, upstream 5xx responses, authentication
failures, and invalid payloads count; valid empty results, policy/input
rejections, quota denial, and caller cancellation do not. If the health store
itself fails, requests remain enabled with a diagnostic instead of suppressing
every provider.

Each manifest may attach `owner`, terms and methodology links, a data-use class,
credential owner, attribution, and a review date to a source. Treat the review
date as an operational reminder: it is evidence of the last review, not a claim
that external terms can never change.

Integration routes consume one host rate-limit tier. Ordinary routes use
`public`; upstream-heavy point or list work declares `expensive`; bursty tile
proxies declare `tile`. Metrics expose only closed aggregate labels—never
coordinates, station names, credentials, or arbitrary error text.

### Air-quality metrics

The existing authenticated/internal `GET /api/internal/metrics` endpoint exports
the canonical air-quality instruments through the shared Prometheus renderer:

| Instrument | Important bounded labels | Meaning |
| --- | --- | --- |
| `air_quality_requests_total` | method, outcome, cache result, headline class, rejection code, compatibility use, quota truncation | End-to-end canonical and legacy route outcomes |
| `air_quality_request_duration_ms` | same as request counter | End-to-end latency |
| `air_quality_evidence_count` | same as request counter | Returned evidence or station-feature count |
| `air_quality_provider_calls_total` | provider ID, method, outcome, cache ownership, suppression | Provider dispatches plus policy/health preflight skips |
| `air_quality_provider_call_duration_ms` | same as provider counter | Provider-call latency |
| `air_quality_raster_age_seconds` | current, stale, unavailable | Served raster age when a raster provider is released |

`cache_result="provider-managed"` means the provider owns its internal cache and
the provider contract does not leak a per-call cache decision. The canonical
request instrument still records the combined response cache state. A health or
policy suppression is represented as a skipped provider call with zero latency;
it is not disguised as an upstream error. Provider IDs are validated integration
identifiers, and all other labels come from closed enums.

Suggested starting alerts (tune them to local traffic and maintenance windows):

- page when canonical `unavailable|error` outcomes exceed 5% for 10 minutes and
  at least 20 requests were made;
- warn when one provider's `error|timeout` outcomes exceed 25% for 15 minutes;
- warn on sustained `suppression="health"` for a provider that should be active;
- warn when `quota_truncated="true"` or `cache_result="stale-if-error"` persists
  for 15 minutes;
- if a raster addendum is eventually shipped, warn when its current-frame age
  exceeds twice the provider's documented update cadence.

These are documentation examples only. OpenMapX does not create an external
dashboard, notification channel, or alert rule without operator authorization.

## AI-assisted search disclosure

When [natural-language search](../features/natural-language-search.md) is active,
OpenMapX adds disclosures to its legal pages automatically, based on what is
actually enabled:

- `/terms` shows an **AI-assisted search** reliability disclaimer whenever any AI
  provider is active. The local provider is on by default, so this normally
  appears.
- `/privacy` adds a **cloud data-transfer** row for each active processor. The
  built-in Anthropic, OpenAI, Google, and OpenRouter adapters supply this metadata
  automatically. An arbitrary cloud-compatible endpoint must declare its
  processor name, country, and privacy URL before configuration is accepted.
  With the local-only default, nothing is transferred and no row appears.

The signal is computed server-side from booleans and secret-free processor
metadata only; provider configuration and API keys are never exposed. Duplicate
processor IDs are collapsed in the rendered table.

## Bulk operations

Configuring features one page at a time is tedious on a fresh deployment, so the
list's toolbar links to **Bulk configure** (`/admin/integrations/bulk`), a single
page that consolidates the same workflow. It renders every configurable
integration's settings form and credentials table inline, expanding on demand,
and drives the *same* save and credential endpoints as the per-integration pages
— so there's no separate "bulk" behavior to learn, just every form in one place.

The bulk page also publishes the complete **environment-variable catalogue** for
your installation: for each integration, the exact `INTEGRATION_<ID>_<KEY>`
variable name behind every setting and secret, with present / missing flags and
non-secret defaults. Copy the block you need into `infra/docker/.env` when you'd
rather pin configuration in the environment than click through forms. Secret
*values* are never exposed here — only their variable names and whether each is
currently set.

For acting on backend services in bulk (start, stop, or update selected services),
see [Services administration](./services-administration.md) and
[Managing services](../install/managing-services.md).

## Ride hailing

Four integrations make up the ride mode, and only one of them needs any
configuration to be useful:

- **Ride Hailing** — the orchestrator. Holds the default provider and the
  fare-comparison setting.
- **Ride Apps** — handoffs to Uber, Lyft, Bolt, FREENOW and Yango. Works out of
  the box; the affiliate ids are optional.
- **GOFS On-Demand Rides** — open on-demand feeds. Reads a community registry by
  default, and takes your own feeds on top.
- **Ride Partners** — credential fields and setup guides only, for vendors that
  need a commercial agreement. No provider appears from it.

### Where feeds come from

The **Use the MobilityData GOFS registry** setting is on by default. It reads the
community-maintained list of published on-demand feeds, so a newly published
system appears without a configuration change on your side. Every entry is
checked before it is offered: unreachable feeds are hidden, and feeds that need
an API key are shown with a link to that operator's access page rather than
failing silently.

### Adding a feed by hand

1. Find the operator's discovery URL — their own site, or the
   `<link rel="gofs">` autodiscovery tag on it. Many feeds serve it at a bare
   base URL such as `https://api.example.com/gofs/11` rather than a path ending
   in `gofs.json`.
2. Open the GOFS On-Demand Rides integration and add a row with a short stable
   id, a display name and the https URL.
3. Save.

The feed's own service areas, brands, fares and booking links are read from it,
so nothing else needs configuring. An entry here overrides a registry entry with
the same id, which is how you point at a private or staging deployment.

### Giving a feed an API key

For a feed OpenMapX ships named support for — the Montreal taxi registry today —
paste the key into its own field and follow the setup guide shown beside it.

For any other keyed feed, set the row's **API key slot** to 1, 2 or 3, choose
whether the key goes in a header or a query parameter and what it is called, then
paste the key into the matching **Custom GOFS feed N API key** field. Header is
the default and the better choice: a key in a query string ends up in access logs.

Keys are stored encrypted in the credential vault and sent only to that feed.
Saving one reloads the integration, so it takes effect without a restart, and a
feed that was showing as needing a credential re-checks immediately.

### Enabling fare comparison

**Allow side-by-side fare comparison** is off by default, and turning it on is an
assertion about the terms you operate under: several ride-hailing providers' API
terms forbid presenting them in an aggregated view alongside competitors.
Providers that forbid it are never added to the list whatever this setting says —
they stay as separate options — so switching it on affects only open feeds that
have declared comparison permitted.

### Privacy

Quote requests send the rider's pickup and destination to the configured feed,
from your server rather than the rider's browser. Nothing is cached or stored,
and which feeds are contacted is entirely your choice. Storing a Yango or Karhoo
credential does not yet enable a provider; the API log says so on startup.

## Where to go next

- **[Admin panel](./admin-panel.md)** — the full tour of `/admin` and how access
  is gated.
- **[Ride integrations](../developer/ride-integrations.md)** — writing a ride
  provider against the `RideProvider` contract.
- **[Services administration](./services-administration.md)** — enabling and
  operating the backends that satisfy capability requirements.
- **[Community extensions](./community-extensions.md)** — installing additional
  integrations and services from the unified Extensions store.
- **[Configuration](../install/configuration.md)** — `.env`, secrets, and how the
  cascade fits the wider deployment.
- **[Monitoring](./monitoring.md)** — health history, background jobs, and the
  audit log.
