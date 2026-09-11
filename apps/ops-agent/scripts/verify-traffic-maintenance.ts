import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { createDockerRuntime } from "../src/docker-runtime";
import { dispatchOpsOperation } from "../src/runtime";

/**
 * Disposable acceptance probe for the pinned Valhalla maintenance lifecycle.
 *
 * The fixture must be named `om043-maintenance-engine`, bind
 * `/tmp/om043-maintenance/valhalla/osm-pbf` at `/custom_files`, and publish
 * port 8002 only to loopback port 51870. The preflight below rejects any other
 * container or mount before the runtime can stop or mutate it.
 */

const SYNTHETIC_CONTAINER = "om043-maintenance-engine";
const TRAFFIC_DATA_ROOT = "/tmp/om043-maintenance";
const ROUTE_URL = "http://127.0.0.1:51870/route";
const execute = promisify(execFile);

interface DockerInspect {
  Name: string;
  Mounts: Array<{ Source: string; Destination: string; RW: boolean }>;
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

const inspected = await execute("docker", ["inspect", SYNTHETIC_CONTAINER], {
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
});
const containers = JSON.parse(inspected.stdout) as DockerInspect[];
assert.equal(containers.length, 1, "expected exactly one synthetic Valhalla fixture");
const container = containers[0];
assert.ok(container);
assert.equal(container.Name, `/${SYNTHETIC_CONTAINER}`);

const expectedSharedDir = await realpath(`${TRAFFIC_DATA_ROOT}/valhalla/osm-pbf`);
assert.match(expectedSharedDir, /^\/(?:private\/)?tmp\/om043-maintenance(?:\/|$)/);
const customFiles = container.Mounts.find((mount) => mount.Destination === "/custom_files");
assert.deepEqual(
  customFiles && { source: await realpath(customFiles.Source), writable: customFiles.RW },
  { source: expectedSharedDir, writable: true },
  "synthetic fixture must use only its disposable /tmp graph mount",
);
assert.deepEqual(container.NetworkSettings.Ports["8002/tcp"], [
  { HostIp: "127.0.0.1", HostPort: "51870" },
]);

const runtime = createDockerRuntime({
  composeFile: "/unused",
  releaseComposeFile: "/unused",
  releaseComposeExists: () => false,
  trafficDataRoot: TRAFFIC_DATA_ROOT,
  execFile: async (file, args, options) => {
    assert.equal(file, "docker");
    const syntheticArgs = args.map((arg) =>
      arg === "docker-valhalla-1" ? SYNTHETIC_CONTAINER : arg,
    );
    return execute(file, syntheticArgs, options);
  },
});
const operation = { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" } as const;
const result = await dispatchOpsOperation(runtime, operation, {
  signal: AbortSignal.timeout(90_000),
  emitLog: () => undefined,
  claim: {
    fingerprint: "a".repeat(64),
    operation,
    source: "registry",
    capability: { revisionId: "synthetic-maintenance-v1", values: {} },
  },
});

const manifest = JSON.parse(
  await readFile(`${TRAFFIC_DATA_ROOT}/valhalla/osm-pbf/traffic-generations.json`, "utf8"),
) as Record<string, unknown>;
assert.equal(manifest.graphGeneration, manifest.extractGeneration);
assert.equal(manifest.graphGeneration, manifest.waysToEdgesGeneration);
await assert.rejects(access(`${TRAFFIC_DATA_ROOT}/valhalla/osm-pbf/.traffic-maintenance.json`));

const response = await fetch(ROUTE_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    locations: [
      { lat: 52, lon: 12.996 },
      { lat: 52, lon: 13.024 },
    ],
    costing: "auto",
    date_time: { type: 0 },
  }),
});
const route = (await response.json()) as { trip?: { summary?: { length?: number } } };
assert.ok(response.ok, `synthetic route failed with HTTP ${response.status}`);
assert.ok(
  typeof route.trip?.summary?.length === "number" && route.trip.summary.length < 2,
  "synthetic route did not recover after maintenance",
);

process.stdout.write(
  `${JSON.stringify({ result, baselineKm: route.trip.summary.length }, null, 2)}\n`,
);
