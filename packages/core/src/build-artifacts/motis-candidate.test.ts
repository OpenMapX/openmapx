import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveOperationsProfile } from "@openmapx/transitous-core";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-shared-motis-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const files: Record<string, string> = {
    "config.yml": "timetable: {datasets: {demo: {path: demo.gtfs.zip}}}\n",
    "license.json": "[]",
    ".openmapx-feed-proxy/conf/default.conf": "server { listen 80; }",
    ".openmapx-feed-proxy/feed-proxy-vars.json": "{}",
    "demo.gtfs.zip": "synthetic timetable",
    "transit-source-manifest.json": '{"version":1,"sources":[]}',
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { mode: 0o755, recursive: true });
    writeFileSync(join(root, path), bytes, { mode: 0o644 });
  }
  const artifact = (path: string) => ({
    path,
    sha256: sha(files[path]!),
    sizeBytes: Buffer.byteLength(files[path]!),
  });
  const manifest = {
    schemaVersion: 1,
    epoch: "epoch-fixture",
    createdAt: "2026-10-30T00:00:00.000Z",
    expectations: {
      timetableDatasets: 1,
      realtimeFeeds: 0,
      gbfsFeeds: 0,
      expectsGbfs: false,
      tilesEnabled: false,
      elevationEnabled: false,
      routedTransfersEnabled: false,
      gbfsProxyUrl: null,
      feedProxyUrls: [],
    },
    canary: {
      bbox: { minLat: 1, minLng: 1, maxLat: 2, maxLng: 2 },
      plan: { fromLat: 1, fromLng: 1, toLat: 2, toLng: 2 },
      expectedRentalProviderIds: [],
    },
    artifacts: {
      config: artifact("config.yml"),
      license: artifact("license.json"),
      proxyConfig: artifact(".openmapx-feed-proxy/conf/default.conf"),
      proxyVars: artifact(".openmapx-feed-proxy/feed-proxy-vars.json"),
      datasets: [artifact("demo.gtfs.zip")],
      sourceManifest: artifact("transit-source-manifest.json"),
    },
  };
  writeFileSync(join(root, "motis-candidate-manifest.json"), JSON.stringify(manifest), {
    mode: 0o644,
  });
  return manifest;
}
async function api() {
  expect(
    existsSync(join(import.meta.dirname, "motis-candidate.ts")),
    "shared candidate validation is missing",
  ).toBe(true);
  return import("./motis-candidate");
}
it("verifies the shared complete candidate, including actual hardlinked proxy bytes", async () => {
  const manifest = fixture();
  linkSync(join(root, ".openmapx-feed-proxy/conf/default.conf"), join(root, "mounted-proxy.conf"));
  expect(await (await api()).verifyCandidateManifest(root)).toEqual(manifest);
});
it.each(["traversal", "duplicate", "digest", "size", "empty", "shape"])(
  "refuses malformed %s inventory before validation",
  async (kind) => {
    const manifest = fixture();
    if (kind === "traversal") manifest.artifacts.datasets[0]!.path = "../outside";
    if (kind === "duplicate") manifest.artifacts.datasets.push(manifest.artifacts.datasets[0]!);
    if (kind === "digest") manifest.artifacts.datasets[0]!.sha256 = "x".repeat(64);
    if (kind === "size") manifest.artifacts.datasets[0]!.sizeBytes = -1;
    if (kind === "empty") manifest.artifacts.datasets = [];
    if (kind === "shape") manifest.expectations.timetableDatasets = -1;
    writeFileSync(join(root, "motis-candidate-manifest.json"), JSON.stringify(manifest), {
      mode: 0o644,
    });
    await expect((await api()).verifyCandidateManifest(root)).rejects.toThrow();
  },
);
it("rejects symlinked intermediate artifact directories", async () => {
  fixture();
  const outside = mkdtempSync(join(tmpdir(), "omx-motis-outside-"));
  try {
    writeFileSync(join(outside, "default.conf"), "server { listen 80; }", { mode: 0o644 });
    rmSync(join(root, ".openmapx-feed-proxy/conf"), { recursive: true });
    symlinkSync(outside, join(root, ".openmapx-feed-proxy/conf"));
    await expect((await api()).verifyCandidateManifest(root)).rejects.toThrow();
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
it("detects changed candidate content and honors cancellation", async () => {
  fixture();
  writeFileSync(join(root, "license.json"), "changed", { mode: 0o644 });
  const mod = await api();
  await expect(mod.verifyCandidateManifest(root)).rejects.toThrow(/hash mismatch/);
  const abort = new AbortController();
  abort.abort();
  await expect(mod.verifyCandidateManifest(root, abort.signal)).rejects.toThrow();
});
it("bounds manifest metadata and leaves source bytes unchanged", async () => {
  fixture();
  const before = readFileSync(join(root, "demo.gtfs.zip"));
  writeFileSync(join(root, "motis-candidate-manifest.json"), " ".repeat(32 * 1024 * 1024 + 1), {
    mode: 0o644,
  });
  await expect((await api()).verifyCandidateManifest(root)).rejects.toThrow();
  expect(readFileSync(join(root, "demo.gtfs.zip"))).toEqual(before);
});

it.each(["mirror", "build"] as const)(
  "preserves the resolved %s operations policy",
  async (source) => {
    const manifest = {
      ...fixture(),
      operationsPolicy: resolveOperationsProfile({ countries: ["de"], source }),
    };
    writeFileSync(join(root, "motis-candidate-manifest.json"), JSON.stringify(manifest), {
      mode: 0o644,
    });
    expect(await (await api()).verifyCandidateManifest(root)).toEqual(manifest);
  },
);
