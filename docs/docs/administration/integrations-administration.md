---
title: Integrations & bindings
description: Configure integrations through the layered config cascade, set secrets, choose capability bindings, and check integration health.
sidebar_position: 3
---

# Integrations & capability bindings

Use `/admin/integrations` with a full administrator account to enable features,
set credentials and choose backend bindings. Integrations declare their settings
and dependencies in `manifest.json`. Backend containers are managed separately
under [Services](./services-administration.md); install community components
through [Extensions](./community-extensions.md).

## The integration list

`/admin/integrations` lists every loaded integration with its display name, the
domains it serves, whether it's enabled, its health, and whether its credentials
and required services are satisfied. Click into one to open its detail page,
which is organized into tabs:

- **Overview**: metadata, the services and other integrations it depends on,
  and the capability-binding picker.
- **Configuration**: the per-integration settings form, plus a read-only table showing
  every resolved value and where it came from.
- **Credentials**: the secret fields the integration declares, and their status.
- **Health**: the current probe result, with a button to re-run it.
- **Data Sources**: source declarations, licensing and privacy metadata.

To configure a feature:

1. Open the integration and check its required services and credentials.
2. Set non-secret values on **Configuration** and secrets on **Credentials**.
3. Save, then inspect health and run a request using that feature.

The enable/disable toggle controls whether the integration participates in the
runtime. Config and credential saves reload integrations. An explicit **Reload**
queues a background job; follow its terminal result in
[Activity](./monitoring.md). Reloads can rebuild the shared integration host, so
inspect the result for failures beyond the selected feature.

## Configuring an integration

The Configuration form uses the manifest's schema for booleans, enumerations, numbers
and text. An integration without configurable fields shows a note.

Saving validates writable non-secret keys, publishes the trusted configuration
and reloads integrations. Use Credentials for secrets and the enable/disable
control for `enabled`. An API save failure can leave an unknown host outcome;
inspect the returned error and current state before trying again.

### The config cascade

Each setting's effective value is resolved through a layered cascade. The
**Configuration** tab shows a `source` chip next to every field naming the layer that
won. An environment-driven field is disabled because a saved value cannot override it.

There are five layers. Highest priority wins:

| Priority | Source        | Where it comes from                                      |
| :------: | ------------- | -------------------------------------------------------- |
|    5     | `env`         | A host environment variable, `INTEGRATION_<ID>_<KEY>`.   |
|    4     | `config.json` | A `config.json` file in the integration's own directory. |
|    3     | `vault`       | An admin-set secret in the encrypted vault.              |
|    2     | `database`    | A value you saved in the Config form.                    |
|    1     | `default`     | The schema default.                                      |

If a saved value does not take effect, inspect its source. An environment or
`config.json` override can hide a database or vault value. Change the winning
layer or remove the override, then reload. Empty environment strings are treated
as unset. The environment must reach the API process: adding a line to
`infra/docker/.env` requires the relevant container to be recreated before the
process can read it.

The environment-variable name follows a fixed pattern: `INTEGRATION_`, then the
integration's id, then `_`, then the config key. Both the id and the key are
hyphen-normalized (hyphens become underscores) and upper-cased. A camelCase
schema key like `apiKey` has no hyphens to normalize, so it is set by
`INTEGRATION_<ID>_APIKEY`:

```bash
# infra/docker/.env — overrides the `apiKey` setting of the `geocoding-maptiler` integration
INTEGRATION_GEOCODING_MAPTILER_APIKEY=your-key-here
```

Hyphenated keys are normalized the same way. For example, the
`db-bike-api-key` config key of the `bike-sharing` integration is set by:

```bash
# infra/docker/.env — overrides the `db-bike-api-key` setting of the `bike-sharing` integration
INTEGRATION_BIKE_SHARING_DB_BIKE_API_KEY=your-key-here
```

See [Configuration](../install/configuration.md) for deployment settings.
Backend service settings use the separate `SERVICE_<ID>_<KEY>` cascade described
in [Services administration](./services-administration.md#config).

### Secrets

A field marked `"x-openmapx-secret": true` belongs on **Credentials**.
The Configuration view masks its value, and administrative responses do not return the
credential body. Credential status reports the effective source, which can be
`env`, `config.json`, `vault`, `database` or `default`, or `missing`. Vault update
metadata is separate from the layer currently supplying the value.

Set or rotate a secret from that tab. Its value is encrypted at rest in the
database vault, which requires `OPENMAPX_SECRETS_KEY` to be set on the API host
(generate one with `openssl rand -hex 32`). Without that key the vault is
unavailable and the panel says so; an integration that _declares_ secret fields
will refuse to load at startup until the key is present, so configure it before starting the API even when credentials will come from environment overrides.

You can also supply a secret entirely through the environment, with the same
`INTEGRATION_<ID>_<KEY>` naming convention. Protect the deployment environment as secret material. As always,
the env value wins over a vaulted one. The credential summary is configured only when every declared secret has an effective nonempty value. A missing optional credential may therefore keep that summary incomplete even when the feature can serve some requests.

Where an integration's manifest provides it, each credential also shows a short
**setup guide** with a "Get API key" link to the
provider's registration page, an optional pre-filled request email for providers
that grant access by hand, a free-tier/pricing hint, and a collapsible list of
steps to obtain the value. It appears next to the field on the Credentials tab,
on the bulk-configure page, and in the Set-credential dialog, with the provider-specific registration instructions.

## Capability bindings

Integrations can require a named service or a capability such as
`routing-engine` or `geocoder`. When several enabled services provide the same
capability, choose one with a binding. A requirement for a named service has no
provider choice.

How a requirement resolves at load time:

- **A `service:` requirement** names one specific service. It's satisfied if that
  service is installed and enabled.
- **A `capability:` requirement with exactly one provider** is auto-selected.
  Nothing to do; the single matching service is used.
- **A `capability:` requirement with multiple providers** is _ambiguous_. The
  integration won't resolve that requirement until you pick a binding. Until then the requirement remains unsatisfied.
- **An optional requirement** can remain unresolved without a required-dependency warning. Any public fallback is integration-specific; optionality alone does not provide one.

You choose a binding on the integration's **Overview** tab. Each `capability:`
requirement shows a dropdown listing every installed service that provides it;
pick one to bind it, or choose the clear-binding option to clear the binding and
let requirement resolution run again. A fallback exists only when that integration implements one. The picker only offers
services that declare the capability; the API rejects a service that does not provide it.

A binding is a stored `(integration, capability) → service` mapping. Saving it
also applies the trusted configuration and reloads the integration. The panel
shows **Saved** and **Active** separately: a saved choice is only active after
the host has activated that exact provider generation. If reload fails, the
previous provider remains active and the desired choice stays saved. Use
**Apply saved binding** to make a new explicit attempt. Disabled integrations
remain pending until enabled. **Refresh binding status** reads the retained
operation outcome without repeating the write.

Changes check the previously observed mapping and revision, so a stale page
cannot overwrite another administrator's choice. Refresh after a conflict.
Binding changes and their retained outcomes are audit-logged.

Saving a binding does not start its service. The provider must be enabled and
offer the required capability.

:::note[Bindings are per integration, not global]
The same capability can be bound to different services for different
integrations. You must also
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

- **up**: the probe succeeded.
- **down**: the probe failed (connection refused, a timeout, an HTTP error);
  the last error is shown.
- **unconfigured**: a required config key or secret is unset, or a self-hosted
  service the check points at isn't enabled. This is treated as "not set up yet,"
  not a failure, so a feature you haven't configured doesn't show up as broken.

The summary treats an integration without a health check as healthy, but its Health endpoint reports `unconfigured` with “No health check defined”. Neither establishes runtime availability. Some integrations
run several sub-checks (for example, one per country or per upstream); those
roll up into a single signal: any sub-check down makes the integration down,
otherwise any up makes it up. Probe history is retained, so the
[Monitoring](./monitoring.md) view can show trends rather than just the current
state.

:::note[Health checks must target public hosts]
Public status uses the scheduled health snapshot. To prevent server-side requests to arbitrary internal targets, a manifest's external `healthCheck` URL or TCP target must resolve to a public host. A check pointed at
a loopback, link-local, or private-range address (`127.0.0.1`, `169.254.169.254`,
…) is rejected and reported as down. Built-in `service:` targets use the internal service resolution exception.
:::

## Data-use policy

Some data sources carry licence terms a commercial deployment may not be able to
honour. Each source declares a `commercialUse` stance in its manifest, and
OpenMapX lets an operator gate the two restrictive classes:

- **Non-commercial sources** (`commercialUse: "no"`): for example Open-Meteo's
  free tier.
- **Grey-area sources** (`commercialUse: "unknown"`): public APIs whose terms
  are merely undocumented.

Both are allowed by default. Review the terms for your deployment and disallow either class from
`/admin/settings`, or with the `OPENMAPX_ALLOW_NONCOMMERCIAL` /
`OPENMAPX_ALLOW_GREY_AREA` environment variables (environment takes precedence). The policy cache refreshes at a 30-second
interval and is invalidated by relevant settings changes. Orchestrators use the
excluded provider/source sets, and the response filter removes tagged excluded
data. Mixed-source integrations need source-level handling; these controls are
not a general licence validator or proof that no upstream traffic occurred.
Sources marked `conditional` still require review of their conditions.

OpenConditions states a permission per use for each of its feeds (display,
redistribution, derived products, retention, commercial use): `yes` only where
the licence grants it and someone has checked the publisher's own statement of
that licence, `no` where it is denied, `unknown` otherwise. A feed whose
display is denied is not shown at all. A feed whose display or commercial use
is unknown counts as grey area. Routing builds a product from the data, so a
road closure or speed limit shapes routes only when its derived use,
retention and commercial use are permitted. The same two controls decide the
rest: grey-area rights route only while grey-area sources are allowed, and a
non-commercial source only while non-commercial sources are. A denied derived
use or retention never routes.

:::note[Disclosure tables still list every source]
Disabling a source removes its _data_ from results, but the `/privacy` and
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
counted failures or a failure rate of at least 25% over at least four samples
degrades a provider. Five consecutive counted failures or a failure rate above
50% over at least ten samples opens it. Cooldowns increase
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
proxies declare `tile`. Metrics expose only closed aggregate labels; never
coordinates, station names, credentials, or arbitrary error text.

### Air-quality metrics

The internal `GET /api/internal/metrics` endpoint exports
the canonical air-quality instruments through the shared Prometheus renderer:

| Instrument                              | Important bounded labels                                                                           | Meaning                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `air_quality_requests_total`            | method, outcome, cache result, headline class, rejection code, compatibility use, quota truncation | End-to-end canonical and legacy route outcomes         |
| `air_quality_request_duration_ms`       | same as request counter                                                                            | End-to-end latency                                     |
| `air_quality_evidence_count`            | same as request counter                                                                            | Returned evidence or station-feature count             |
| `air_quality_provider_calls_total`      | provider ID, method, outcome, cache ownership, suppression                                         | Provider dispatches plus policy/health preflight skips |
| `air_quality_provider_call_duration_ms` | same as provider counter                                                                           | Provider-call latency                                  |
| `air_quality_raster_age_seconds`        | current, stale, unavailable                                                                        | Served raster age when a raster provider is released   |

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

Configure alert rules and notification channels in your monitoring system. Keep the scrape endpoint network-restricted; it has no application authentication guard. See [Metrics](./monitoring.md#metrics).

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

Open **Bulk configure** (`/admin/integrations/bulk`) to edit several integrations
on one page. Each form uses the same save and credential endpoints as the
individual detail page. Review the result of each save.

The bulk page also publishes the complete **environment-variable catalogue** for
your installation: for each integration, the exact `INTEGRATION_<ID>_<KEY>`
variable name behind every setting and secret, with present / missing flags and
non-secret defaults. Copy the block you need into `infra/docker/.env` when you'd
rather pin configuration in the environment than click through forms. Secret
values are excluded; only variable names and present/missing flags are shown.

For acting on backend services in bulk (start, stop, or update selected services),
see [Services administration](./services-administration.md) and
[Managing services](../install/managing-services.md).

## Ride hailing

Four integrations make up the ride mode, and only one of them needs any
configuration to be useful:

- **Ride Hailing**: the orchestrator. Holds the default provider and the
  fare-comparison setting.
- **Ride Apps**: handoffs to Uber, Lyft, Bolt, FREENOW and Yango. Works out of
  the box; the affiliate ids are optional.
- **GOFS On-Demand Rides**: open on-demand feeds. Reads a community registry by
  default, and takes your own feeds on top.
- **Ride Partners**: credential fields and setup guides only, for vendors that
  need a commercial agreement. No provider appears from it.

### Where feeds come from

The **Use the MobilityData GOFS registry** setting is on by default. It reads the
community-maintained list of published on-demand feeds, so a newly published
system appears without a configuration change on your side. Every entry is
checked before it is offered: unreachable feeds are hidden, and feeds that need
an API key are shown with a link to that operator's access page rather than
failing silently.

### Adding a feed by hand

1. Find the operator's discovery URL on its site or in the
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

For the Montreal taxi registry, paste the key into its named credential field and follow its setup guide.

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
The setting permits comparison only for providers that declare it allowed. A provider that forbids comparison remains a separate option.

### Privacy

Quote requests can send pickup, destination and optional addresses to a configured feed from the server. Quote responses use `Cache-Control: no-store`; static feed discovery and upstream retention have separate behavior. Review the feed's privacy terms before enabling it. Storing a Yango or Karhoo
credential does not yet enable a provider; the API log says so on startup.

## Where to go next

See [Services](./services-administration.md) for backends,
[Extensions](./community-extensions.md) for additional components, and
[Monitoring](./monitoring.md) for health and jobs. Provider authors can use
[Ride integrations](../developer/ride-integrations.md).

## Importing saved integration configuration

Integration exports contain writable non-secret overrides and optional export
metadata. Import validates the whole file first, then replaces overrides for the
named integrations. Omit `enabled` to retain its saved state; provide a boolean to
change it. Empty per-integration configuration resets its non-secret overrides.
Unnamed integrations and credential vault entries are unchanged. Unknown,
read-only or invalid fields reject the whole import, and masked values such as
`***` cannot become settings. Older unknown database fields are omitted from new
exports. An empty file has no work to perform and is rejected.

A successful response means the batch was saved, one full trusted configuration
was applied and integrations were reloaded. A failure can report that prior state
was restored, or that reconciliation is required. Restoration never authorizes
overwriting a newer administrator/host edit. If reconciliation is required,
inspect saved configuration, the applied host generation and runtime state before
making another deliberate change. Do not automatically retry the import.

## Portable configuration and protected credentials

System Settings includes configuration migration with an ownership inventory.
Export contains declared database-owned non-secret settings, integration and
service configuration, bindings, and installation prerequisites. Environment
and file overrides, vault values, bootstrap keys, and unsupported metadata are
listed as omissions. Install missing extensions and resolve required credentials
before applying dependent configuration.

Import a configuration JSON file of at most 1 MiB, review the selected scopes and
prerequisites, and apply its ten-minute preview. The preview is bound to the
administrator and original configuration sources. A changed configuration or
source requires a new preview. Selected desired changes share one guarded
transaction and generation; later provider or host effects can remain partial or
unknown. Activity retains those outcomes. Imported authentication settings are
pending drafts until the separate authentication policy Apply action.

Platform fields use the existing origin, DNS/TLS, OAuth, passkey and alternate
login confirmations. Domain changes require a fresh purpose-bound sign-in and
use the same guarded generation as the other selected configuration.

Protected credential transfer exports only explicitly selected, effective vault
credentials to `openmapx-vault-transfer.json.enc`. Supply a passphrase of 12–1024
UTF-8 bytes and confirm a fresh administrator sign-in. The authenticated encrypted
file is at most 1 MiB. A lost export response requires another explicit sign-in;
the server does not retain the passphrase or a plaintext export for replay.

On import, confirm sign-in to decrypt and review the file, then explicitly choose
which fields to import or skip. Existing ordinary credentials are overwritten
only when selected. Managed Transitous credentials also require the current
catalog and credential revisions: selected feed IDs are merged, unselected keys
are preserved, and only explicitly listed deletion IDs are removed. Applying a
managed transfer requires both import and transit-credential purposes from one
fresh sign-in. The encrypted preview expires after ten minutes; changing choices
invalidates its prior confirmation. Passphrases are cleared after each request
and when the dialog closes.
