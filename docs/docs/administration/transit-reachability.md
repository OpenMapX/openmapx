# Transit reachability

OpenMapX provides three public-transit reachability paths:

- an **estimated map surface**, generated from one MOTIS one-to-all request and rendered via WebGL;
- an **exact finite point check**, used to filter the currently displayed Explore results against a verified self-hosted MOTIS instance;
- **sampled exportable polygons**, computed by sampling a spatial lattice over MOTIS one-to-many queries.

MOTIS 2.11 natively does not return isochrone polygons from its one-to-all endpoint — it returns reachable stops and their travel times. OpenMapX renders those seeds as an estimated WebGL field: from every reached stop it adds the remaining walking budget in a straight line. The result is fast and visually informative, but barrier-blind; for GIS-grade polygon exports, OpenMapX provides the sampled isochrone pipeline detailed below.

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

## Exportable polygons

There is a third artifact, and the three make different accuracy claims. Keeping
them distinct is what stops an export from being read as more authoritative than
it is:

| Artifact | Egress model | Claim | Cost |
| --- | --- | --- | --- |
| **Estimated** field | straight line from each reached stop | barrier-blind visual estimate | one MOTIS request |
| **Sampled** polygons | street-routed at each lattice point, interpolated between | accurate at the sample points; boundary uncertain within about one cell | 8–32 MOTIS requests |
| **Exact** point check | street-routed at that coordinate | authoritative for that coordinate | one or two MOTIS requests |

Sampled polygons are downloadable RFC 7946 GeoJSON. The file carries an
`openmapx` member holding the origin, departure minute, walk profile, source,
dataset epoch, sampling metadata, attribution, and an explicit accuracy note, so
it stays self-describing after it leaves OpenMapX. It is **not** an exact
isochrone, and area or population figures derived from it inherit both the
sampling error and any bbox clipping.

### Enabling

Set the `transit-motis` option `exportableIsochronesEnabled: true`. It is off by
default and sits strictly behind exact reachability: every gate listed above
must already pass, plus this switch. A closed gate reports
`exportableIsochroneReason` and disables nothing else.

### Sampling budget

A request supplies a bbox, which the server clamps to 900 km² of **ground** area
(about 30 × 30 km) and reports `clippedToBbox` when it does. The lattice spacing
is `max(100 m, sqrt(area / 2048))`, rounded up onto a fixed ladder so a nudged
viewport reuses the same lattice and the same cached field. A 30 × 30 km request
resolves to roughly 660 m; a 10 × 10 km request to roughly 220 m.

Lattice points are sampled through `one-to-many-intermodal` in sequential
batches of `min(advertised maxOneToManySize, 128)`, with a per-batch 30-second
timeout and a 60-second budget across the run. Sampling is all-or-nothing: a
field missing a failed batch would contour that region as unreachable, which is
silently wrong rather than visibly broken.

Because MOTIS performs **one** timetable search per request and reuses it for
the whole batch, cost is roughly `batches × timetableSearch + samples ×
streetOffset`. Raising MOTIS `limits.onetomany_max_many_` above its default of
128 therefore cuts the dominant term; OpenMapX reads the advertised value, so
that tuning takes effect with no code change. If a run does not fit the
60-second budget on your hardware, lower the sample budget: resolution degrades,
correctness does not.

### Load and caching

Only one isochrone computation runs per API instance at a time; concurrent
callers receive `429` with `Retry-After`. Without that limit a handful of users
could issue hundreds of sequential MOTIS batches and starve ordinary journey
planning. The route is also in the expensive rate-limit tier.

The **sampled field** is cached for 900 seconds under a key that deliberately
excludes the thresholds. Contouring a cached field costs milliseconds, so
changing a threshold re-contours instantly instead of re-sampling for a minute.

A bbox spanning the antimeridian is rejected rather than split.

### Accuracy benchmark

```bash
pnpm exec tsx scripts/benchmark-transit-isochrone-accuracy.ts \
  --base-url http://127.0.0.1:3001 \
  --lat 52.525 --lng 13.369 --minutes 30
```

The script generates polygons, draws deterministic sample points across the
sampled bbox, and compares polygon inclusion against exact one-to-many checks.
Disagreements within two cells of the boundary are expected and reported, not
gated — the polygon interpolates between lattice points there. Disagreements
further than two cells from the boundary have no sampling explanation and exit
non-zero.

Roll back by turning `exportableIsochronesEnabled` off; the estimated field and
journey planning are untouched by it.
