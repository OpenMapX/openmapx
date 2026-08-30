---
title: Air quality integrations
sidebar_position: 9
---

# Air quality integrations

OpenMapX air-quality providers return source evidence. They do not choose the place headline and must not silently convert a provider field into a regional standard. The pure `@openmapx/air-quality` package owns normalization, standards, jurisdiction, deduplication, and deterministic selection; `@openmapx/integration-framework` owns the provider capability contract.

## Evidence and coherence

Each `ProviderEvidence` item keeps the provider and source IDs, original records, basis (`ground`, `hybrid`, or `model`), timestamps, spatial support, raw pollutant series, published indices, and complete attribution. Keep original concentration values and units. Conversion is allowed only within the same physical dimension; never infer temperature or pressure to convert a gas between mass and volume units.

Calculations use one structural coherence key:

- ground inputs share one provider location; separate sensors at that location may contribute pollutants;
- model inputs share provider, model run, grid cell, and vertical level;
- published reporting-area/community aggregates remain published aggregates;
- pollutant window ends may differ by at most one declared cadence and never more than 60 minutes.

Do not accept an upstream coherence key as proof. The normalizer derives it. A duplicate is the same source record, spatial support, pollutant, and interval. Redistributors merge source references; conflicting normalized values emit `duplicate_conflict`.

## Authority, basis, and method identity

These fields answer different questions:

| Field | Meaning |
| --- | --- |
| `dataAuthority` / index `authority` | Who is responsible for the evidence or calculation |
| `basis` | Ground, model, or a disclosed hybrid |
| `derivation` | Agency/provider-published index or OpenMapX-computed index |
| `methodId` / `methodRevision` | Exact calculation or publication method |
| `standardId` / `standardRevision` | Reviewed regional standard, when conformance is proven |

A field called `us_aqi` or `european_aqi` is not enough to claim an OpenMapX standard revision. Leave `standardId` null until its windows, rounding, breakpoint behavior, categories, and fixtures pass conformance. Published Canadian AQHI/AQHI+ is validated only with named community coverage, issue/valid times, and the declared conventional or hourly PM2.5 wildfire method. It is never recalculated from one station. Québec resolves to Info-Smog; an ECCC AQHI there can remain secondary evidence but cannot impersonate Info-Smog.

## Standards and windows

Call `registerBuiltinStandardAdapters()` once during orchestrator initialization, then resolve by evidence time. Current aliases resolve to pinned revisions and the resolved revision belongs in cache keys. The launch registry contains:

- US EPA May 2024 AQI, including the 2024 PM2.5 bands and particle NowCast;
- current EEA European AQI with station-type qualification and disclosed CAMS gap filling;
- UK DAQI from 13 April 2026 with 24-hour PM, eight-hour O3, hourly NO2, and 15-minute SO2;
- CPCB NAQI with its pollutant-count, particle, window, and completeness rules;
- HJ 633-2026, effective 1 March 2026 in China;
- ECCC-published community AQHI/AQHI+ validation only.

An adapter returns a typed failure when required series, samples, units, coherence, or effective revision are missing. Providers should return the best traceable input evidence rather than fill gaps or calculate a different window.

The calculated adapters consume these exact intervals:

| Standard | Current evidence | Daily/history evidence |
| --- | --- | --- |
| US EPA 2024 | Particle NowCast from the latest 12 hourly slots; one- and eight-hour ozone; eight-hour CO; one-hour NO2; one- and 24-hour SO2 | 24-hour particles/SO2 and the daily maxima of rolling one- or eight-hour gas windows. A complete rolling eight-hour day therefore needs the preceding seven hourly slots. |
| EEA European AQI | One complete hourly concentration per pollutant | Same hourly method at the evidence time |
| UK DAQI | 24-hour PM, eight-hour O3, one-hour NO2, and 15-minute SO2 at 75% capture | Same pollutant windows at the evidence time |
| CPCB NAQI | 24-hour PM/NO2/SO2/NH3 or eight-hour CO/O3, at least 16 hours in the preceding day, three pollutants, and one particle | Same running windows. The official table leaves Severe concentration bands open-ended and states no concentration-rounding rule for the decimal gaps between integer-labelled bands; OpenMapX returns `unverified_method` on either unsettled path instead of inventing breakpoints. |
| HJ 633-2026 | One-hour concentrations for all six pollutants | Daily SO2/NO2/CO/PM means and the daily maximum eight-hour O3 mean; output method IDs distinguish real-time and daily AQI. |

Every contributing interval must match the declared cadence and occupy a unique cadence-aligned slot. Duplicate, off-grid, stale, wrong-duration, or wrong-unit samples do not manufacture completeness.

## Jurisdiction resolution

The server-only `@openmapx/air-quality/server` entry resolves coordinates with a checked-in Natural Earth 5.1.1 1:10m artifact. It contains supported Admin-0 geometry, Canadian Admin-1 geometry, relevant disputes, and explicit program registry entries. Caller country/subdivision values are assertions, not overrides. A conflict, relevant dispute, or multiple program candidate is `ambiguous`; ocean and uncovered points are `unresolved`. Neither silently defaults to US EPA. Canada also requires a provider community match before AQHI can headline.

The browser-safe root entry deliberately excludes hashing, the generator, the resolver, and its geometry.

## Provider contract

Register an `AirQualityProvider` with `ctx.registerAirQualityProvider(provider)`. The host validates setup before storing it:

- `sourceIds` are unique and every ID exists in the integration manifest's `dataSources`;
- lower integer `priority` breaks ties only within the same scientific evidence class;
- optional `timeoutMs` is an integer from 250 through 4,500 ms;
- declared `current`, `forecast`, `stations`, and `raster` capabilities exactly match implemented methods;
- at least one operational retrieval capability is present;
- `published-index` and `pollutants` accompany at least one retrieval method;
- coverage declares uppercase country codes and/or a valid WGS84 bounding box.

Every method receives `ProviderCallContext`. Pass `call.signal` through cache refresh and all upstream I/O. The orchestrator combines the provider timeout with the request deadline and does not dispatch after the parent deadline expires. Point/viewport inputs and returned evidence must remain bounded; providers return no final headline.

```ts
ctx.registerAirQualityProvider({
  id: "example-air",
  sourceIds: ["example-air-source"],
  priority: 20,
  timeoutMs: 3000,
  capabilities: new Set(["current", "pollutants"]),
  coverage: { countries: ["US"] },
  async getCurrent(query, call) {
    return loadEvidence(query, { signal: call.signal });
  },
});
```

## Selection and forecasts

Selection is lexicographic and permutation-invariant. Freshness comes first, followed by evidence class (agency-published local, qualifying OpenMapX ground calculation, validated model), publication basis, point coverage, monitor class, whole-metre distance, newer evidence time, lower provider priority, and stable index ID. A computed monitor must be stationary, reference/regulatory, complete, and within 50 km. Evidence from 50–100 km is secondary context. Mobile and low-cost evidence stays visible but cannot become a computed headline.

Raw fallback uses its own tuple and sets `primaryEvidenceId` while leaving `primaryIndexId` null. Explicit comparison indices never replace the automatically resolved local standard. Forecast frames are the request-window start plus unique provider validity starts; a daily official value is not interpolated into invented hourly values.

## Fixture and artifact provenance

Every standard snapshot records official URLs, document anchors, retrieval/effective dates, a SHA-256 of the canonical transcription, and the independent fixture-derivation record. Boundary tests cover every supported program country, supported overseas/island geometry, international boundaries, disputes, all Canadian provinces/territories, Québec, ocean, and hint mismatch.

The jurisdiction generator never downloads `latest`. Obtain exactly these Natural Earth archives and verify the recorded hashes in `src/data/jurisdiction/metadata.json`:

```bash
curl -fL -o /tmp/ne-admin0-5.1.1.zip https://naturalearth.s3.amazonaws.com/5.1.1/10m_cultural/ne_10m_admin_0_countries.zip
curl -fL -o /tmp/ne-admin1-5.1.1.zip https://naturalearth.s3.amazonaws.com/5.1.1/10m_cultural/ne_10m_admin_1_states_provinces.zip
curl -fL -o /tmp/ne-disputed-5.1.1.zip https://naturalearth.s3.amazonaws.com/5.1.1/10m_cultural/ne_10m_admin_0_disputed_areas.zip
```

After extracting each archive, place a sibling `.VERSION.txt` containing `5.1.1` beside each `.shp`, then run:

```bash
pnpm -C packages/air-quality generate:jurisdiction -- --admin0 /path/ne_10m_admin_0_countries.shp --admin0-archive /tmp/ne-admin0-5.1.1.zip --admin1 /path/ne_10m_admin_1_states_provinces.shp --admin1-archive /tmp/ne-admin1-5.1.1.zip --disputed /path/ne_10m_admin_0_disputed_areas.shp --disputed-archive /tmp/ne-disputed-5.1.1.zip --output src/data/jurisdiction/supported.geojson --metadata src/data/jurisdiction/metadata.json
```

Review the generated feature counts and artifact checksum. Regeneration is a reviewed data change, not a dependency-update side effect.

## Canonical orchestration boundary

The built-in `integrations/air-quality` module owns `/current`, `/forecast`, and
`/stations`. It discovers enabled `air-quality` registrations on every request,
so activation and hot reload do not leave a captured provider list. It evaluates
source policy and health before invoking a provider, dispatches eligible
siblings concurrently, and isolates timeout, quota, authentication, transport,
empty, and malformed-payload outcomes.

Current and station providers have an effective three-second deadline; forecast
providers have four seconds; the parent request stops provider work at five
seconds. A provider is capped at four current evidence objects or 120 forecast
intervals. Canonical envelopes are capped at 32 current or 1,024 forecast
evidence objects and two MiB. Truncation removes whole evidence/features and is
reported; it never slices provenance fields.

Normalization is the trust boundary. Provider payloads are strict runtime
schemas, source IDs must have matching attribution and origin records, time and
spatial identities must cohere, and official published-standard claims pass the
registered adapter's validator. Unknown provider-native methods remain visible
with `standardId: null` and can never win the local-standard sort.

Point response caches bind a non-rendering coordinate digest, resolved standard
revision, comparison request, provider generation, policy exclusions, and
health suppression. Serving stale-if-error preserves the evidence timestamps
and adds `stale_cache`; it does not relabel old evidence as newly observed.
Station pagination stores an ordered, projected snapshot for five minutes in
the distributed runtime (maximum 2,000 features/eight MiB). Signed cursors hold
only snapshot ID, query hash, schema revision, and offset.

## Open-Meteo modeled evidence

`weather-open-meteo-air-quality` now registers a global modeled provider rather
than a weather-domain dependency. It requests bounded current/hourly fields via
the framework HTTP client and preserves the returned CAMS grid coordinate,
hourly cadence, near-surface level, UTC/time-zone metadata, model basis, and
Open-Meteo/CAMS attribution. Current cache windows are 15 minutes/one hour/three
hours (soft/hard/stale-if-error); forecast windows are 30 minutes/two hours/six
hours.

The upstream `european_aqi` and `us_aqi` fields are retained as published
methods `open-meteo-european-aqi` and `open-meteo-us-aqi`, revision
`open-meteo-air-quality-v1`, with both standard fields null. Their names are not
proof of conformance with OpenMapX's reviewed EEA and EPA adapters. Regional
indices are independently computed only when the returned pollutant windows
meet those adapters' requirements.
