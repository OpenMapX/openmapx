# Transit reachability

OpenMapX has two deliberately separate public-transit reachability paths:

- an **estimated map surface**, generated from one MOTIS one-to-all request;
- an **exact finite point check**, used only to filter the currently displayed
  Explore results and only against a verified self-hosted MOTIS instance.

MOTIS 2.11 does not return isochrone polygons. Its one-to-all endpoint returns
reachable stops and their travel times. OpenMapX renders those seeds as an
estimated WebGL field: from every reached stop it adds the remaining walking
budget in a straight line. The result is useful visually but is barrier-blind,
is not an exportable polygon, and must not be used for area or population
statistics.

## Fixed assumptions

Both paths use profile `foot-1.2-cap-900-v1`:

- MOTIS pedestrian profile `FOOT`;
- walking speed 1.2 metres per second;
- access, egress, and direct-walk caps of 900 seconds each;
- depart-at requests using one captured, minute-normalized instant;
- at most four thresholds, with a maximum of 90 minutes.

The surface query requests only the largest selected threshold. The browser
composites all lower bands from the same remaining-time field, so changing a
lower band does not add another MOTIS query. The API thins seeds deterministically
from a 100-metre Web Mercator grid and coarsens it until no more than 4,096 seeds
remain. Responses report the raw count, retained count, and grid size.

## Exact filtering gate and privacy boundary

Exact checks call MOTIS's experimental
`POST /api/experimental/one-to-many-intermodal` endpoint. They are disabled by
default. Set the `transit-motis` integration option
`exactReachabilityEnabled: true` only after the benchmark below passes.

The effective capability still remains closed unless all checks pass:

- the active runtime is the local/self-hosted MOTIS instance;
- the runtime is healthy and has street routing;
- the promoted `/api/v1/map/initial` limits support the 90-minute and
  900-second assumptions;
- `maxOneToManySize` is positive;
- the one-origin/one-destination promotion canary succeeded for this dataset.

An old capability snapshot, a failed experimental canary, or a disabled switch
does not block transit dataset promotion or normal planning. It only disables
exact filtering. Destination coordinates are never sent to Transitous or
Stadia. A surface may fall back to Transitous because it contains only the same
single-origin one-to-all query used for the estimated display.

Exact requests accept at most 200 destinations. The adapter uses sequential
batches of `min(advertised limit, 128)`, preserves destination order and IDs,
and has one 30-second deadline covering the entire operation. A response is
released only after every batch succeeds. While a check is pending—or when it
is unavailable, malformed, cancelled, or failed—the browser keeps every Explore
result visible. There is no partial mask.

## Caching, limits, and fallback

Surface and exact results are cached server-side for 300 seconds using the
dataset epoch, rounded coordinates, departure minute, profile, modes, budget,
and (for exact checks) an opaque hash of ordered destination IDs and coordinates.
The surface has a public five-minute cache header. Exact responses are private
and carry no reusable browser cache lifetime. Both reachability POST routes use
the API's expensive-public rate-limit tier.

The renderer requires WebGL2 plus a floating-point color attachment and
floating-point blending. When that is unavailable or shader initialization
fails, OpenMapX shows reachable-stop dots and an explanatory message; it does
not attempt an expensive CPU polygon union. Stops can also be enabled as a
diagnostic overlay and are hidden by default. Transit attribution comes from
the actual response envelope. Street-mode attribution is also response-aware:
self-hosted Valhalla is credited as Valhalla, while Stadia appears only when
the final hosted fallback actually answered.

Transitous asks high-volume users to coordinate usage, identify their client,
cache responses, and preserve attribution. The estimated surface adds one
one-to-all request, not per-stop fan-out. Operators planning high public volume
should still coordinate with Transitous.

## Benchmark and rollout

Run against a small local dataset first:

```bash
pnpm exec tsx scripts/benchmark-motis-reachability.ts \
  --base-url http://127.0.0.1:8081 \
  --lat 52.525 --lng 13.369
```

The script uses deterministic destinations within roughly two kilometres,
runs sizes 1, 128, and 200, performs two warmups plus ten measurements, and
prints median, p95, maximum, and success count. It exits non-zero after any
measured failure or when the 200-destination p95 exceeds 30 seconds. Remote or
public targets are rejected unless `--allow-remote` is explicitly supplied.

Roll out in this order:

1. promote and inspect capability metadata while exact checking stays off;
2. verify estimated bands, wording, attribution, and browser fallback;
3. pass the 200-destination benchmark with zero measured failures;
4. enable `exactReachabilityEnabled` and verify rate limiting/cancellation.

To roll back, turn off `exactReachabilityEnabled`. Estimated surfaces and normal
transit planning remain available. Metrics expose bounded source, capability,
cache, outcome/error, latency, seed/grid, destination, and batch information;
they never include origins, destination coordinates, or result IDs.

True exportable polygons remain a separate future feature. The preferred path
is adaptive grid destinations through local MOTIS one-to-many followed by
contouring, with its own performance, resolution, topology, and cache study—not
per-stop Valhalla fan-out.
