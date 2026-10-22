# MBTA transit provider

All seven registered transit methods use six generated JSON:API GET operations.
No route/shape/planning capability is advertised. `provider.ts` selects operations,
`mapping.ts` converts validated resources, `client.ts` owns host acquisition and
pagination, and `index.ts` owns instance configuration, receipts and retirement.

A configured key is required for every call, including alerts, vehicles and
facilities. Missing configuration produces empty provider results and an
unconfigured health status. Keys travel only in `x-api-key` headers. Requests
select `MBTA-Version: 2021-01-09`, the established API default, independently of
the key's portal setting. No streaming or anonymous fallback is used.

Fresh calls require working host shared admission and cooldown capabilities.
Admission is scoped to origin and a SHA-256 identity of the key, shared across
operations, instances and replicas: 1,000 requests per 60 seconds with 60 ms
spacing. Only spacing may wait within the operation deadline. Provider exhaustion
and 429 responses establish a shared cooldown using `x-ratelimit-reset` epoch
seconds, with a conservative 60-second fallback. Missing runtime/store denies
acquisition. External users of the same key cannot be counted by this store.

Requests reject redirects and use the host's bounded JSON:API reader: 8-second
acquisition deadline and 2 MiB per page. Collections allow 50 pages, 5,000 distinct
primary resources and 20,000 distinct included resources under one deadline.
Pagination can change only the expected offset; the path, filters and 100-item
page size must remain the same. A later-page error or bound violation rejects the
collection rather than returning a successful partial result. Upstream failures
remain sanitized typed errors so the host can distinguish failure from valid
empty data. No new result cache is introduced.

Nearby queries accept positive radii up to 100 km, query a conservative angular
candidate region and filter by actual haversine metres. Departure windows are
positive and at most 24 hours. Departure destinations use prediction overrides
then included trip headsigns; platform codes come from included stops. Missing
schedules keep the known expected time in both canonical display time and
`expectedAt`, with no inferred delay. Invalid/missing position coordinates or
vehicle observation timestamps are omitted rather than replaced with zero/now.

Shutdown cancels owned policy/admission/HTTP waits and prevents late publication.
Source and integration policy are checked before acquisition and before results
leave the instance. Source receipts are captured for the acquisition, independent
of other instances or later manifest changes.

Regenerate offline with `pnpm mbta:generate`; verify with `pnpm check-mbta`.
The original snapshot, hash, licence and reviewed corrections are documented in
[schema/NOTICE.md](schema/NOTICE.md). Generated schemas validate consumed fields,
including typed prediction includes and nullable relationships; other upstream
fields are deliberately projected out. Contract drift requires deliberate review.
