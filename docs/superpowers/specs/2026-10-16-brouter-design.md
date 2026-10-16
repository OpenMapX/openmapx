# BRouter service and cycling routing

## Intent and delivery

Add an optional, self-hosted bicycle router to OpenMapX. Work directly on main,
with two delivery gates: deploy and verify the Germany service first; only then
implement and deploy the cycling provider and user options. The user explicitly
authorizes commits, pushes and both deployments and delegates design decisions.

## Service

Use the existing service manifest, selection and configuration mechanisms. The
service stays out of default selections, has no public proxy, and exposes port
17777 on the private network and host loopback. Run the checksum-pinned BRouter
1.7.10 distribution on a digest-pinned maintained Temurin 17 JDK image. The JDK's
ZIP utility extracts the release; this avoids the published upstream Docker
image, which currently contains 1.7.8 despite newer repository documentation.
A read-only mounted Bash supervisor owns downloads and Java process lifecycle;
it never has Docker access. A named volume stores the verified distribution and
routing generations. Limit the container to 2 GB and Java to a 1 GB heap; allow
two routing calculations and a bounded calculation timeout by default.

Operator config: REGION defaults to europe/germany, accepts Germany alias,
Geofabrik extract paths and planet. Select existing upstream 5-degree tiles
intersecting the region bounding rectangle, including border areas. Download
prebuilt segments rather than generating OSM graphs. Refresh weekly by default.
Select data from the official segment index and use its announced sizes to reject
truncated downloads. Fetch the matching current lookup table. Stage each complete
dataset separately and publish via atomic symlink replacement. Retain the serving
generation on failed updates. Never serve a cached different region after an
operator changes coverage. Restart Java on publication so old caches cannot mix
with new files. Preserve one old generation until publication completes. Shutdown
terminates downloads and Java. Health requires prepared coverage and a responding
engine. Document resource usage, configuration, update behavior and provenance.

## Cycling integration

Add routing-brouter through IntegrationContext, registering only when a service
or an explicitly configured operator endpoint exists. Do not use public BRouter
instances implicitly. Cycling-only priority precedes Valhalla. HTTP, parse,
timeout and coverage errors participate in the existing provider fallback chain;
pinned navigation requests keep their established provider semantics. Timed trips
and optimization continue through compatible existing providers.

Offer a compact cycling section in existing route options: trekking, road,
gravel and mountain bike, hill avoidance and preference for quieter roads.
Keep options provider-neutral and map them to both BRouter and Valhalla so fallback
retains intent as far as each engine supports it. Carry options through store,
queries, cache identities, shared links, scheduled requests and rerouting as
applicable. Apply BRouter profile parameters, alternatives, ferry avoidance and
no-go areas; convert geometry, elevation, durations, legs and maneuver cues into
OpenMapX contracts. Credit actual suppliers. Do not imply dynamic traffic support
or safety guarantees. Preserve navigation step/geometry alignment.

## Acceptance

Test coverage selection and malformed input, failed/truncated update preservation,
manifest rendering and optionality, real engine startup and restart; then verify
Germany routes directly on production. Feature checks cover request validation,
option/cache identity, profile mapping, maneuver/leg conversion, multi-waypoint
routes, fallback and attribution, persistence and rerouting. Run project quality
and policy gates, OpenAPI generation/check, builds and an independent final code
review. Inspect desktop/mobile-width UI and actual public requests after deployment.
No physical-device ride test is claimed.

## Self-review

The two stages are explicit. No public API permission is assumed. Coverage change
cannot reuse a mismatched cached dataset. Generic bike preferences also map to
Valhalla. Timed/optimized and explicitly pinned navigation retain their contracts.
