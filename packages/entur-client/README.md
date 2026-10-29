# Entur runtime client

`@openmapx/entur-client` is the private host-HTTP adapter and native Geocoder v3
SDK used by `geocoding-entur`, `transit-entur` and `live-transit-entur`.
Each integration setup constructs an independent client and provider runtime.
Configuration, source IDs and deeply
frozen attribution receipts are captured before asynchronous acquisition;
reloads cannot redirect an earlier request or relabel its results. Domain mapping
belongs to the integrations. Generated Geocoder operations and validators belong
to this package; GraphQL operations and pure non-geocoder wire helpers belong to
[`@openmapx/mobility-formats`](../mobility-formats/entur/README.md).

## Configuration and transport

The client receives `IntegrationContext.http`, the optional `upstreamRuntime`,
resolved configuration, captured contributors and a source-policy callback.
Integrations retain their own enablement, configuration and shutdown signal;
there is no mutable singleton or setter facade. Configuration is normalized and
validated during detached setup before the host publishes registrations.

| Setting                  | Default                                             |
| ------------------------ | --------------------------------------------------- |
| `clientName`             | `openmapx-server`                                   |
| `journeyPlannerEndpoint` | `https://api.entur.io/journey-planner/v3/graphql`   |
| `vehiclesEndpoint`       | `https://api.entur.io/realtime/v2/vehicles/graphql` |
| `nsrEndpoint`            | `https://api.entur.io/stop-places/v1/read`          |
| `geocoderEndpoint`       | `https://api.entur.io/geocoder`                     |

Endpoint overrides require HTTPS, without embedded credentials or a fragment.
`clientName` is sent as `ET-Client-Name` on every request. The implementation
accepts at most 200 characters, using lowercase ASCII letters/digits in two or
more hyphen-separated segments (`company-application`), without spaces. Empty or
whitespace-only settings use the defaults. Choose an identity unique to the
deployment's company and application, following Entur's
[client identification guidance](https://developer.entur.no/docs/getting-started#client-identification-et-client-name).
These integrations use open APIs and do not implement OAuth; Entur documents
OAuth client credentials for its separate
[partner APIs](https://developer.entur.no/docs/authentication).

Requests reject redirects, allow at most 8 MiB of response data and share an
eight-second lifetime across source-policy checks, admission, spacing waits and
HTTP/body acquisition. The Geocoder SDK adds an overall operation deadline,
described below. Source policy is checked before transport and again before
publication, including after an admission wait. Errors expose bounded kinds and
an optional HTTP status, without raw provider bodies, messages or URLs. HTTP
status and allowlisted cooldown headers are handled before success decoding, so
a non-JSON 429 is still a provider failure. GraphQL envelope decoding rejects
partial/error responses; generated types and JSON parsing do **not** validate
every field of an arbitrary runtime result. No extra GraphQL client or limiter
library is used.

## Native Geocoder v3 SDK

`createEnturGeocoder(client, { timeoutMs, policy })` requires an injected
`EnturClient`. Its `autocomplete(params, signal)`, `reverse(params, signal)` and
`place(params, signal)` methods each require a caller `AbortSignal` and return a
validated `EnturGeocoderResult`. The SDK owns all three native GET operations:
`/v3/autocomplete`, `/v3/reverse` and `/v3/place`. The configured base URL is
unversioned; generated paths supply `/v3`. Raw generated operations are internal,
with no public request, header, URL, method or schema overrides and no fallback
transport.

The Orval-generated operations and Zod contracts use only the host HTTP client.
Exactly HTTP 200 is successful for Geocoder; other statuses remain typed HTTP
failures even with empty or non-JSON bodies. Input validation rejects unknown,
legacy and wrong-operation keys. It validates the supplied values but serializes
the original values, so schema defaults do not add radius, weight or other omitted
parameters. Zero and false values are retained where valid, `undefined` is
omitted, and array parameters use form-style comma-separated values
(`explode: false`). Autocomplete requires a nonblank `q` or a meaningful filter;
any focus settings require both `lat` and `lon`. Place lookup accepts 1–100
nonblank, comma-free native IDs. Responses validate finite WGS84 coordinates;
additive fields are tolerated and stripped. An unknown supplier is a response
error. An unknown string `stopPlaceRole` is omitted, while a non-string role is
invalid; the SDK never infers `standalone` from omission.

The default SDK lifetime is 8,000 ms. `geocoding-entur` selects 4,000 ms and
`transit-entur` selects 8,000 ms. The deadline covers supplier/API policy checks,
admission and cooldown waits, HTTP/body acquisition, response validation and
publication checks, including callbacks that never settle. Caller cancellation
takes precedence over timeout classification. Failures use `EnturRequestError`
with a bounded `kind` (including `config`, `policy`, `http`, `response`, `abort`
and `timeout`) and optional HTTP `status`. The geocoding domain maps cancellation
and timeout to its typed provider errors. Policy or transport failures cannot
become successful empty results.

### Configuration and identity

Both consumers expose `boundaryCountry`: omitted means `no`, an exact empty
string means unscoped, and any nonempty value must be two lowercase ASCII letters
(ISO 3166-1 alpha-2). Uppercase, whitespace and alpha-3 values are rejected.
Suggestion coverage is bounded for `no` and `se`; other accepted countries and
the unscoped setting have no suggestion coverage bound. `multiModal` is the
configuration key, with `parent` (default), `child` and `all` values; its native
wire parameter is `multimodal`. The geocoding integration's `endpoint` and the
transit integration's `geocoderEndpoint` configure the same unversioned base.

Native `properties.id` values round-trip unchanged through `/v3/place`.
For `NSR:StopPlace:337`, domain IDs include
`{ entur: "NSR:StopPlace:337", nsr: "StopPlace:337" }` with primary scheme
`nsr`. Other suppliers retain the full native ID under `entur`, for example
`{ entur: "OSM:TopographicPlace:123" }`. The resolver uses the exact requested ID,
not an unrelated first feature. Mapping uses native layer, address, category,
name and transport metadata without numeric-ID guessing or a default bus mode.

### Supplier policy and receipts

Integration setup captures API and supplier contributors before any async
acquisition. `createEnturGeocoderSources({ contributors, isSourceAllowed })`
provides the SDK policy and `contributorsFor(feature)`. Setups pass that policy
to the SDK; API and supplier permission are checked before acquisition and again
before publication. The API source remains `entur-geocoder`.

| Native supplier                 | Manifest source ID                      | Data terms |
| ------------------------------- | --------------------------------------- | ---------- |
| `nsr`                           | `entur-geocoder-nsr`                    | NLOD-2.0   |
| `openstreetmap`                 | `entur-geocoder-osm`                    | ODbL-1.0   |
| `kartverket-matrikkelenadresse` | `entur-geocoder-kartverket-addresses`   | CC-BY-4.0  |
| `kartverket-stedsnavn`          | `entur-geocoder-kartverket-place-names` | CC-BY-4.0  |
| `custom-poi`                    | `entur-geocoder-custom-poi`             | NLOD-2.0   |

Receipts credit the service and the actual supplying data source for each
result. Populated place fields and individual ID fields retain their captured
receipts. Transit stop search declares only NSR data. An ID whose namespace
cannot establish a supplier requires all possible suppliers to be declared and
allowed before lookup. A reload or source-policy change cannot redirect or
relabel an earlier generation's acquisition.

The [developer guide](../../docs/docs/developer/entur-geocoder.md) describes the
factory boundary and offline generation. The pinned schema's
[EUPL notice](schema/NOTICE.md) and [licence](schema/LICENSE.EUPL-1.2) are separate
from the generator licence, handwritten package code, returned supplier data
terms and Entur's service-access terms. Preserve each applicable notice.

## Shared admission and observed cooldowns

Journey Planner follows Entur's
[identified-consumer rate policy](https://developer.entur.no/docs/open-services/journey-planner/rate-limiting):

| Request class                              | Requests per first-request minute |           Minimum spacing |
| ------------------------------------------ | --------------------------------: | ------------------------: |
| `PlanTripDocument` (`trip`)                |                               500 | 7 ms (`ceil(1000 / 150)`) |
| Other Journey Planner operations (`other`) |                             1,000 | 5 ms (`ceil(1000 / 200)`) |

The shared identity is the upstream **origin + client name + API family**, under
the `entur` scope. Class-specific counters/spacing share a family-wide cooldown.
Integration ID, endpoint path, receipts, bounding box and reload generation do
not create new quota buckets. The host uses Redis time for atomic admission and
starts each minute window with its first admitted request. The local policy
cannot account for external applications or deployments reusing the same client
name outside this shared store.

Fresh Journey Planner calls require a working shared Redis-backed runtime with
both `admitSharedRequest` and `deferSharedRequests`. Missing/incomplete runtime,
store failure, exhausted minute quota or active cooldown denies acquisition.
Only spacing denial waits and rechecks admission, within the cancellable request
lifetime. Quota/cooldown denial and provider failures are not automatically
retried or cached as successful empty results.

Vehicles, NSR and Geocoder have no numeric policy in this client. With shared
admission they observe family cooldowns across replicas. Only when the entire
runtime is absent can they proceed using a per-client observed cooldown: at most
four family entries, with each delay capped at 24 hours. A supplied but incomplete
or unavailable runtime fails closed. HTTP 429 cooldowns use valid positive
`Retry-After` / `Rate-Limit-Expiry-Time` delays, with the provider `Date` as the
time reference when available; shared delays retain their full safe duration.
This fallback is not distributed quota enforcement.

Cancellation stops waiting and rejects late results. It cannot recall an already
dispatched Redis command, so a quota reservation or cooldown may conservatively
remain after its caller has retired. Admin cache clears scan `int:*` / `cache:*`
and leave `upstream-shared:*` admission state intact. Explicit store wipes,
including the existing CLI `cache clear --all` (`FLUSHDB`), remove that state too.

## Cache and health ownership

The live integration caches one national situation snapshot through
`ctx.cache.withCache` for 15 seconds, then filters it per bounding box. Its cache
identity includes normalized configuration, source IDs and receipts; a hit keeps
the acquisition's original `fetchedAt`. There is no added L1/HTTP cache or stale
fallback. Identical generations can share the host fill across bounding boxes
and reloads; retiring one caller cancels that waiter without cancelling another
live generation's identical shared fill. Policy and lifetime guards prevent late
publication.

Transit and live transit each register one primary composite health check.
Transit probes Journey Planner, vehicles and NSR; live transit probes vehicles
and Journey Planner situations. The geocoding integration's primary health check
uses exact `/v3/place` lookup of `NSR:StopPlace:337`; it is down on an error or
missing matching feature. These probes use the same client transport and
admission as normal calls.
