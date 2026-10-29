---
title: Entur Geocoder
description: "The native Geocoder v3 SDK, integration configuration, supplier receipts and offline contract generation."
sidebar_position: 8
---

# Entur Geocoder

`geocoding-entur` and the stop search in `transit-entur` use the private
`@openmapx/entur-client` native Geocoder v3 SDK. It implements all three GET
operations: `/v3/autocomplete`, `/v3/reverse` and `/v3/place`. GraphQL journey
planning, realtime vehicles and the National Stop Register read API use their
separate existing contracts.

Use this page when changing either Entur consumer or regenerating the native
contract. Runtime implementation lives in `packages/entur-client/src/geocoder/`;
configuration and lifecycle ownership remain in the integrations.

| SDK method                     | Native operation       | Required input                                 |
| ------------------------------ | ---------------------- | ---------------------------------------------- |
| `autocomplete(params, signal)` | `GET /v3/autocomplete` | Nonblank text or a meaningful supported filter |
| `reverse(params, signal)`      | `GET /v3/reverse`      | Latitude and longitude                         |
| `place(params, signal)`        | `GET /v3/place`        | 1 to 100 exact native IDs                      |

## Current configuration

| Setting                          | Behavior                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geocoding-entur.endpoint`       | Unversioned base, default `https://api.entur.io/geocoder`.                                                                                            |
| `transit-entur.geocoderEndpoint` | The same unversioned base for transit stop search.                                                                                                    |
| `clientName`                     | Default `openmapx-server`; sent as `ET-Client-Name`. Use a deployment-specific company/application identity.                                          |
| `boundaryCountry`                | One lowercase ISO 3166-1 alpha-2 code. Omitted means `no`; exact `""` disables country scoping. Uppercase, alpha-3 and whitespace values are invalid. |
| `multiModal`                     | `parent` (default), `child` or `all`; serialized as native `multimodal`.                                                                              |

Endpoint overrides require HTTPS without credentials or fragments. The SDK
appends the versioned operation path. Suggestion coverage is bounded for `no`
and `se`; other accepted countries and an empty country setting have no coverage
bound. This is a routing envelope, not a guarantee of supplier data coverage.

IDs preserve native identity. An NSR feature such as `NSR:StopPlace:337` has
primary scheme `nsr` and ID values
`{ entur: "NSR:StopPlace:337", nsr: "StopPlace:337" }`. Other native IDs stay
under `entur`, for example `OSM:TopographicPlace:123`. The place resolver sends
the exact native ID to `/v3/place` and selects the matching feature.

## Runtime boundary

Integration setup constructs `EnturClient` using `IntegrationContext.http`,
`upstreamRuntime`, captured configuration and contributors, and its source-policy
callback. It creates the SDK with `createEnturGeocoder(client, options)` and
captures a generation signal that shutdown aborts. All requests use host HTTP,
source-policy controls and shared upstream admission; generated operations have
no independent network fallback.

The geocoding domain factory receives only
`{ geocoder, sources, signal, country, multiModal }`. The SDK owns transport,
validation and asynchronous policy checks; the factory owns domain projections
and maps SDK abort/timeout errors to typed provider errors. The three SDK methods
require their own caller signal:

```ts
const geocoder = createEnturGeocoder(client, {
  timeoutMs: 4000,
  policy: sources,
});

const suggestions = await geocoder.autocomplete(
  { q: "Oslo", countries: ["no"], multimodal: "parent" },
  signal,
);
const nearby = await geocoder.reverse({ lat: 59.91, lon: 10.75 }, signal);
const places = await geocoder.place({ ids: ["NSR:StopPlace:337"] }, signal);
```

`client`, `sources` and `signal` above are the setup's captured dependencies.
Geocoding selects a 4,000 ms overall lifetime; transit selects 8,000 ms, also the
SDK default. The lifetime includes supplier/API permission checks before
acquisition and publication, HTTP/body acquisition, validation and shared waits.
An unsettled callback remains bounded by that lifetime. Caller abort takes
precedence over timeout. `EnturRequestError` exposes bounded kinds and optional
HTTP status, without provider bodies or URLs. Policy and transport failures
propagate instead of becoming cacheable successful emptiness.

Validation rejects unknown or wrong-operation query keys, partial focus pairs
and autocomplete without text or a meaningful filter. It validates original
values without serializing schema defaults; omitted focus does not add radius
or weight. Arrays use form-style CSV, and place lookup accepts 1 to 100 nonblank,
comma-free IDs. Only HTTP 200 is successful. Result validation rejects unknown
suppliers and invalid WGS84 coordinates while stripping additive fields. Unknown
string stop roles are omitted without inventing a standalone role.

The primary geocoding health check performs exact place lookup of
`NSR:StopPlace:337`. Transit retains its composite Journey Planner, vehicles and
NSR health check. Do not assume regeneration purges caches or invalidates integration versions.
Cache identity and migration are separate consumer concerns.

## Supplier receipts and terms

`createEnturGeocoderSources({ contributors, isSourceAllowed })` captures deeply
frozen receipts before async acquisition. Its SDK policy restricts acquisition
to declared, allowed suppliers and rechecks permission before publication.
Results credit the stable `entur-geocoder` API source and the supplier identified
by native `properties.source`. Populated place fields and individual ID fields
retain those same captured receipts. Transit stop search uses only the NSR
supplier. Source revocation prevents publication, and a new integration
generation cannot relabel a held request's results.

The [runtime client guide](https://github.com/OpenMapX/openmapx/blob/main/packages/entur-client/README.md#supplier-policy-and-receipts)
lists the source IDs. Entur's API service terms, NSR/custom POI data under
NLOD-2.0, OpenStreetMap data under ODbL-1.0, and Kartverket data under CC-BY-4.0
remain separate from the pinned schema's EUPL-1.2 notice, the generator licence
and handwritten code licences. Preserve the schema notice and per-source
attribution; the schema licence alone does not grant hosted-service permission
or determine returned-data terms.

## Offline generation and reviewed refresh

The committed input is
`packages/entur-client/schema/geocoder.openapi.json`: OpenAPI 3.1.1, API version
2026.09.1, SHA-256
`499b75814a4c391bd640e977a724cb7398a71f31fd60cac39bdc864d916ff978`.
The adjacent `NOTICE.md` and `LICENSE.EUPL-1.2` preserve provenance and the
upstream schema notice. Orval generates internal operations and Zod models in
`packages/entur-client/src/geocoder/generated/`; handwritten code belongs
outside that directory.

Run from the repository root with the locked dependencies installed. Use the
check command to verify current artifacts; run generation only when accepting a
contract change:

```sh
pnpm entur-geocoder:generate
pnpm check-entur-geocoder
pnpm exec vitest run scripts/entur-geocoder/codegen.test.ts --project node
```

Generation verifies the exact snapshot hash. Check mode regenerates and formats
in scratch space, compares the complete output and fails on missing or stale
files without rewriting the committed outputs. Both commands are offline. CI's
`pnpm check:policy` includes `check-entur-geocoder` alongside the separate
`check-entur-graphql`; ordinary generation and CI never download a live schema.

A schema refresh is a deliberate maintainer operation: review the approved
upstream bytes and semantic changes, update the notice and hash pin together,
regenerate, and inspect the generated diff. Verify all three operations and both
consumers before accepting it. Do not weaken validators to accommodate contract
drift or hand-edit generated output. See the
[schema notice](https://github.com/OpenMapX/openmapx/blob/main/packages/entur-client/schema/NOTICE.md)
for the recorded upstream source and licence boundaries.

## Troubleshoot a consumer change

| Symptom                                              | Check                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration rejected at setup                      | Use an unversioned HTTPS endpoint, a lowercase two-letter `boundaryCountry` or exact empty string, and `parent`, `child` or `all` for `multiModal`.           |
| No autocomplete results in a region                  | Check the configured country, suggestion routing envelope, requested filters and supplier policy separately. Coverage eligibility does not prove data exists. |
| `policy`, `quota`, `cooldown` or `unavailable` error | Check source permissions, host shared admission and Redis health. Preserve the typed failure; returning successful emptiness can poison caches.               |
| Native place lookup rejected                         | Keep the complete ID, including its namespace. Unknown supplier identity requires all possible supplier permissions before lookup.                            |
| Generated check fails                                | Inspect the pinned input/hash and generated diff. Do not hand-edit generated output or download a live schema during the check.                               |

For focused consumer validation, run:

```sh
pnpm exec vitest run --project node packages/entur-client/src/geocoder integrations/geocoding-entur integrations/transit-entur/geocoder-contributors.test.ts
```

These tests use fixtures and host collaborators. They do not establish live
Entur availability, deployed API revision, current coverage or working
production admission. Verify those separately when the change depends on them.
