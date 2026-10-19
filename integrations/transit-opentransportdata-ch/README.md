# Swiss transit runtime

Each `setup()` creates its own client, datasets, attribution store and provider.
Configuration and contributor receipts are snapshots. Detached candidates never
change the active generation; shutdown retires only the corresponding instances.
The SIRI realtime integration captures the Swiss transit provider from the staged
dependency graph and forwards its complete results, including receipts and freshness.

All upstream requests use the host `HttpClient`. XML and text are bounded; GTFS
feeds are limited to 32 MiB, dataset ZIPs to 64 MiB. Occupancy downloads remain
streamed to a temporary file. Trusted redirects support the Swiss 203 convention;
credentials are removed after crossing origins. Discovered download links must
belong to the declared Swiss/storage hosts. API endpoint overrides require HTTPS.

Authenticated acquisitions consume the shared `UpstreamRuntime` quota before
each actual request, including OJP fallback attempts. Missing quota storage or a
denied quota permits no fresh API request. Cache hits consume no quota. Credential
fingerprints and service families identify quota buckets across reloads; acquisition
cache identities additionally include configuration and receipts. The published
limits are recorded in `client.ts` and should be checked against the
[official limits](https://opentransportdata.swiss/de/limits-and-costs/) when changed.
The host runtime implements atomic fixed windows. Equal misses are coalesced by
the host cache within a process; simultaneous cold misses on separate replicas may
spend additional quota, within the same shared quota bound.

Existing feed TTLs are retained. There is no additional stale-result fallback.
Dataset caches clear on host invalidation and bypass local storage while it is
unavailable; late results cannot refill a retired or invalidated cache. Receipts
stay with the archive that supplied the bytes. Shutdown and invalidation remove
temporary archives; readers that already opened an archive retain that descriptor.

Observed routes are derived from timetable/journey responses and retain their
acquisition receipts. Matching replicas and reloads share them in Redis under
hashed configuration/receipt identities. The bounded local store holds at most
5,000 routes; shared entries retain their original 24-hour expiry when read.
Each public operation captures a host cache writer before acquisition, so a late
derived observation cannot refill Redis after administrative invalidation. Hosts
without managed shared caching retain only their local observations.
Current source policy is checked for acquisitions, cache hits and returned records.
