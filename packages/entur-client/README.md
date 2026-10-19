# Entur runtime client

`@openmapx/entur-client` is the private host-HTTP adapter used by
`transit-entur` and `live-transit-entur`. Each integration setup constructs an
independent client and provider runtime. Configuration, source IDs and deeply
frozen attribution receipts are captured before asynchronous acquisition;
reloads cannot redirect an earlier request or relabel its results. Domain mapping
belongs to the integrations; generated operations and pure wire helpers belong to
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
| `geocoderEndpoint`       | `https://api.entur.io/geocoder/v1`                  |

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
HTTP/body acquisition. Source policy is checked before transport and again before
publication, including after an admission wait. Errors expose bounded kinds and
an optional HTTP status, without raw provider bodies, messages or URLs. HTTP
status and allowlisted cooldown headers are handled before success decoding, so
a non-JSON 429 is still a provider failure. GraphQL envelope decoding rejects
partial/error responses; generated types and JSON parsing do **not** validate
every field of an arbitrary runtime result. No extra GraphQL client or limiter
library is used.

The existing Geocoder v1 request/response semantics are preserved. Switching its
endpoint to v3 does not establish compatibility; a v3 migration requires a
separate contract review.

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

Each integration registers one primary composite health check. Transit probes
Journey Planner, vehicles and NSR; live transit probes vehicles and Journey
Planner situations. These use the same client transport and admission as normal
calls. The Geocoder is not an additional health probe.
