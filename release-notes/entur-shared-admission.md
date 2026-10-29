---
impacts: [breaking, operator-action]
---

## What changes

Both Entur integrations use isolated client/provider runtimes. Reloads preserve
the endpoints and attribution receipts of earlier in-flight requests. Requests
use bounded host HTTP transport, reject redirects and require HTTPS endpoint
overrides without embedded credentials or fragments.

Fresh Journey Planner acquisition now requires working shared Redis admission.
The identified-consumer policy allows 500 trip requests and 1,000 other requests
per first-request minute, with respective minimum spacing of 7 ms and 5 ms.
Quota is shared by upstream origin, client name and API family across both
integrations and replicas. Quota/cooldown denial is not automatically retried.
See Entur's [rate policy](https://developer.entur.no/docs/open-services/journey-planner/rate-limiting).

Vehicles, NSR and Geocoder gain no numeric quotas. They share observed provider
cooldowns when the runtime is available. With no runtime they retain only a
per-client observed cooldown capped at 24 hours; a supplied but incomplete or
unavailable runtime fails closed. The national-situations cache keeps its
15-second TTL and original acquisition timestamp, without stale fallback.

## Who is affected

Installations using `transit-entur` or `live-transit-entur`, especially those
without Redis or with custom endpoint/client-name overrides. Removing the
internal setter/singleton facades also affects in-tree code importing those
implementation details; this is not a public package API release.

## Required action

Provide the normal shared Redis service before relying on fresh Journey Planner
data, including live situations. Verify custom endpoints use HTTPS without URL
credentials or fragments. Set `clientName` to a deployment-specific
`company-application` identity: at most 200 characters of lowercase ASCII
letters/digits in hyphen-separated segments, without spaces. The default remains
`openmapx-server`; separate applications reusing that name outside the shared
store are not counted locally. Entur requires
[client identification](https://developer.entur.no/docs/getting-started#client-identification-et-client-name)
on every request. These open API integrations do not require OAuth credentials.

Admin cache clearing preserves quota/cooldown state; explicitly wiping the Redis
database, including CLI `cache clear --all`, removes it. Cancellation can leave a
conservative reservation from an already dispatched Redis command. Neither
operation changes the provider's own limits.

No database migration or data conversion is required. Geocoder v1 semantics are
unchanged; do not switch an override to v3 as part of this upgrade without a
separate compatibility review.
