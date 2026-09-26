# Road-condition engine and recovery verification

The fixture is synthetic authored test data, not an upstream road dataset. It has a direct eastbound road, a detour, an approach and an exit. Never point the fault injector at a deployed graph. The probe refuses non-loopback URLs and graphs with different way IDs.

Run from the OpenMapX repository root (Docker and the installed workspace are required). The PBF is checked in alongside its readable OSM source; no additional Python dependency is needed.

```sh
probe_dir=$(mktemp -d /tmp/openmapx-traffic-probe.XXXXXX)
probe_image=ghcr.io/valhalla/valhalla-scripted@sha256:f9f12c3f835750fc657d1d030a392f7a548699c1c2a961d083ed761e0db8bc14
cp services/data-manager/src/__tests__/fixtures/traffic-engine/roads.osm.pbf "$probe_dir/roads.osm.pbf"
docker run --rm --entrypoint valhalla_build_config "$probe_image" --mjolnir-tile-dir /probe/tiles --mjolnir-tile-extract /probe/tiles.tar --mjolnir-traffic-extract /probe/traffic.tar > "$probe_dir/valhalla.json"
docker run --rm -v "$probe_dir:/probe" --entrypoint valhalla_build_tiles "$probe_image" -c /probe/valhalla.json -j 2 /probe/roads.osm.pbf
docker run --rm -v "$probe_dir:/probe" --entrypoint valhalla_build_extract "$probe_image" -c /probe/valhalla.json -t -O
docker run --rm -v "$probe_dir:/probe" --entrypoint valhalla_ways_to_edges "$probe_image" -c /probe/valhalla.json
docker run -d --name openmapx-traffic-probe -p 127.0.0.1:51868:8002 -v "$probe_dir:/probe" --entrypoint valhalla_service "$probe_image" /probe/valhalla.json 2
pnpm --filter @openmapx/data-manager exec tsx scripts/verify-road-condition-engine.ts http://127.0.0.1:51868 "$probe_dir"
docker rm -f openmapx-traffic-probe
```

Wait for the disposable service's `/status` response before running the probe. It mutates `traffic.tar` in place, never replaces the file, and leaves it cleared. The parent kills only its own disposable fault worker. A crash occurs after a real binary write but before journal commit; a hung writer blocks its process after the write. Recovery waits for that worker's actual exit, takes the abandoned lock and reconciles the pending journal. The probe also verifies a real two-second lease and corrupt-journal full clear. The lock age is advanced in the fault cases so these checks do not spend twenty seconds waiting; they validate recovery, not production wall-clock scheduling.

## Verified locally on 2026-09-11

Image binary: `valhalla 3.8.3-49cd28bc5`, exact digest above. Baseline 1.919 km / 230.388 seconds; forward closure caused a 3.162 km detour for depart-now auto and motorcycle. Pedestrian and bicycle, requests without a routing time, and requests without `current` did not consume the closure. Reverse travel remained unaffected. Expiry restored the baseline through the same running engine mmap. A standalone cap with no measured/base reference was unapplied and did not increase speed.

Future departure **and arrival** requests that include `current` consumed today's closure. OpenMapX therefore removes that source for these temporal modes; future condition protection remains explicitly unsupported where directed restrictions cannot be represented. An actuation receipt is not proof that a specific route request consumed that graph.

Fault recovery measured 888 ms (killed writer), 490 ms (hung writer after forced stale-lock age), and 2167 ms for the two-second lease. Corrupt-journal recovery passed. These are fixture results, not a production SLO measurement. The supervising process checks every five seconds, fences its own writer after twenty seconds of lock ownership, and requests a verified stop of the fixed Valhalla service if clear/recovery fails. Deployment acceptance must separately measure the full 120-second lease plus cleanup bound under its filesystem, graph size and ops-agent permissions. Docker Desktop mmap propagation required bounded polling (maximum five seconds) rather than assuming an immediate read after a host write.

## Engine-owned watchdog and container loss

The pinned image already contains Python 3; `services/valhalla/scripts/traffic-watchdog.py` uses only its standard library. It is the engine container's PID 1 and owns the original image entrypoint process group. It takes the shared writer lock, validates every index/tile bound and clears retained records **before** starting Valhalla, preserving the tar inode. During serving it checks the journal every two seconds. Expired nonempty effect sets, a missing/corrupt journal or an impossible lease stop the engine group; container restart clears offline before serving again. This protects against losing the entire data-manager container, in addition to DM's independent worker supervisor.

The real pinned-container test applied an eight-second closure lease and performed no DM cleanup. The engine stopped at lease + 3261 ms (HTTP detection) with exit code 78. Restart restored the 1.919 km / 230.388-second baseline. This test uses the same `supervise` function, with a direct `valhalla_service` command so it can reuse the tiny synthetic graph rather than run the image's OSM bootstrap.

After the earlier engine probe has generated `probe-overrides.json` and its container has been removed:

```sh
docker run -d --name openmapx-watchdog-probe -p 127.0.0.1:51869:8002 -v "$probe_dir:/probe" -v "$PWD/services/valhalla/scripts/traffic-watchdog.py:/guard.py:ro" --entrypoint python3 "$probe_image" -c 'import runpy,sys; from pathlib import Path; guard=runpy.run_path("/guard.py"); sys.exit(guard["supervise"](["valhalla_service","/probe/valhalla.json","2"],Path("/probe"),Path("/probe/watchdog-state")))'
pnpm --filter @openmapx/data-manager exec tsx scripts/verify-engine-watchdog.ts http://127.0.0.1:51869 "$probe_dir"
docker inspect openmapx-watchdog-probe --format '{{.State.Status}} {{.State.ExitCode}}'
docker start openmapx-watchdog-probe
# Verify the baseline route again, then clean up the disposable container.
docker rm -f openmapx-watchdog-probe
python3 -B -m unittest discover -s services/valhalla/tests
```

Graph activation is separate from event freshness. `traffic-generations.json` must identify the same graph, extract and raw way-map generation; `traffic-engine.json` supplies the actual serving boot epoch. `.traffic-maintenance.json` quiesces the DM worker. A traced plan is rejected if its epoch changed before the locked write. An uncoordinated scripted-image restart invalidates the old graph manifest; only coordinated maintenance can re-attest it. Coordinated startup prevents the image from rebuilding base tiles after the authority's hash. Missing/mismatched generations withhold live effects and remain actionable operator evidence.

## Coordinated maintenance probe

The ops-agent probe calls the real maintenance operation against a fixed disposable
container. Its preflight rejects another container name, graph mount or published
port. Starting from the synthetic graph built above, use a fresh
`/tmp/om043-maintenance` directory (do not reuse it for other data):

```sh
mkdir -p /tmp/om043-maintenance/valhalla/osm-pbf /tmp/om043-maintenance/traffic
cp -R "$probe_dir/tiles" /tmp/om043-maintenance/valhalla/osm-pbf/valhalla_tiles
cp "$probe_dir/traffic.tar" /tmp/om043-maintenance/valhalla/osm-pbf/traffic.tar
docker run --rm --entrypoint valhalla_build_config "$probe_image" --mjolnir-tile-dir /custom_files/valhalla_tiles --mjolnir-tile-extract /custom_files/valhalla_tiles.tar --mjolnir-traffic-extract /custom_files/traffic.tar > /tmp/om043-maintenance/valhalla/osm-pbf/valhalla.json
docker run -d --name om043-maintenance-engine -p 127.0.0.1:51870:8002 -v /tmp/om043-maintenance/valhalla/osm-pbf:/custom_files -v /tmp/om043-maintenance/traffic:/traffic-state -v "$PWD/services/valhalla/scripts/traffic-watchdog.py:/guard.py:ro" --health-cmd 'curl -fsS http://localhost:8002/status || exit 1' --health-interval 1s --health-timeout 2s --entrypoint python3 "$probe_image" -c 'import runpy,sys; from pathlib import Path; guard=runpy.run_path("/guard.py"); sys.exit(guard["supervise"](["valhalla_service","/custom_files/valhalla.json","2"],Path("/custom_files"),Path("/traffic-state")))'
pnpm --filter @openmapx/ops-agent verify:traffic-maintenance
docker rm -f om043-maintenance-engine
```

The local run verified stop, immutable-image offline rebuild, equal graph/extract/
way-map generations, healthy restart and the 1.919 km baseline. The operation also
uses a fresh bounded cancellation signal to remove its named build container and
verify the engine stopped after failure. A failed operation retains the maintenance
fence. Prepared predicted CSVs are consumed only from their unique generation path.

## Activation

`TRAFFIC_ROAD_CONDITIONS_MODE=shadow` is the deployment default. It fetches, validates and classifies candidates, reconciles away prior event effects, and leaves ordinary measured flow handling independent. Set `active` only after the deployment's graph/recovery, policy-removal and seven-day pilot gates pass. Unknown mode values remain shadow. Missing or expired policy authority and missing original-source routing evidence never authorize event writes. Truck/class-specific effects and caps below the engine's representable non-closed speed remain display-only.

Do not count local synthetic results as a seven-day feed soak or national graph coverage. Use OpenConditions' pilot readiness diagnostics and actual successful graph import provenance before expansion. Roll back event actuation by restoring shadow, allowing the existing short lease to expire, and verifying the cleared graph. Keep ingestion/provider evidence available for diagnosis.

## Per-request engine proof probe

The final proxy serves port 8002 and forwards to a fixed loopback engine on 8004.
To reuse the synthetic graph above, stop its prior container and change only
`httpd.service.listen` in the disposable `valhalla.json` to
`tcp://127.0.0.1:8004`. Then run:

```sh
docker run -d --name om043-route-proof -p 127.0.0.1:51871:8002 -v "$probe_dir:/probe" -v "$PWD/services/valhalla/scripts/traffic-watchdog.py:/guard.py:ro" --entrypoint python3 "$probe_image" -c 'import runpy,sys; from pathlib import Path; guard=runpy.run_path("/guard.py"); sys.exit(guard["supervise"](["valhalla_service","/probe/valhalla.json","2"],Path("/probe"),Path("/probe/watchdog-state"),proxy_address=("0.0.0.0",8002)))'
# Wait for /status before running the fixture.
pnpm --filter @openmapx/data-manager exec tsx scripts/verify-route-traffic-proof.ts http://127.0.0.1:51871 "$probe_dir"
docker rm -f om043-route-proof
```

This probe verifies the real writer → engine proxy → Valhalla provider →
authenticated DM API → route-impact consumer contract. It asserts the first
post-write route consumes the closure, matches its individual proof, and reports
current only with complete matching source and policy receipts. It also exercises
optimized routing, a representable speed cap with a measured reference, shadow,
policy/write mismatches, an unapplied cap, future routing and no-live requests.
The synthetic graph manifest is generated only after verifying the fixture's
exact four way IDs; production manifests must come from coordinated maintenance.
The probe restores the traffic extract in `finally` and never commits data.

Verified with the final proxy loaded on 2026-09-11: 1,919 m baseline, 3,162 m
attested closure detour, route and optimize current, applied speed cap current;
all negative checks passed. Proxy socket regressions separately cover a write or
metadata change during routing, restart/boot mismatch, expired/pending/corrupt
journals, maintenance fences, oversized payloads, unavailable backend and slow
clients. Deployment still needs its own graph/recovery acceptance and feed soak.
