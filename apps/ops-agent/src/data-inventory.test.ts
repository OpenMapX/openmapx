/** Readiness must be metadata-backed, never directory presence. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectDataInventory } from "./data-inventory";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-data-inventory-"));
  roots.push(root);
  const data = join(root, "infra/docker/data");
  mkdirSync(join(data, "osm"), { recursive: true });
  return { root, data };
}
it("pages every extract with stable IDs and does not call unrecorded bytes verified", async () => {
  const { root, data } = fixture();
  writeFileSync(join(data, "osm/z.osm.pbf"), "z");
  writeFileSync(join(data, "osm/a.osm.pbf"), "aa");
  const first = await inspectDataInventory(root, { osmLimit: 1, osmOffset: 0 }),
    second = await inspectDataInventory(root, { osmLimit: 1, osmOffset: 1 });
  expect(first.osm).toMatchObject({
    total: 2,
    offset: 0,
    limit: 1,
    unavailable: false,
    items: [{ filename: "a.osm.pbf", fingerprintState: "missing", sourceFingerprint: null }],
  });
  expect(second.osm.items[0]?.filename).toBe("z.osm.pbf");
  expect(second.osm.items[0]?.artifactId).not.toBe(first.osm.items[0]?.artifactId);
});
it("reports empty prepared directories incomplete and database-backed stores unknown", async () => {
  const { root, data } = fixture();
  for (const p of [
    "osrm-graph",
    "otp-graph",
    "tile-mbtiles",
    "motis/live",
    "nominatim",
    "photon",
    "overpass",
  ])
    mkdirSync(join(data, p), { recursive: true });
  const inventory = await inspectDataInventory(root);
  for (const target of ["osrm", "otp", "tiles", "motis"])
    expect(inventory.builds.find((x) => x.target === target)).toMatchObject({
      built: false,
      readiness: "incomplete",
    });
  for (const target of ["nominatim", "photon", "overpass"])
    expect(inventory.builds.find((x) => x.target === target)).toMatchObject({
      built: false,
      readiness: "unknown",
    });
});
it("reports legacy build records as unknown rather than verified readiness", async () => {
  const { root, data } = fixture();
  mkdirSync(join(data, "otp-graph"));
  writeFileSync(join(data, "otp-graph/graph.obj"), "graph");
  mkdirSync(join(data, ".openmapx-builds"));
  writeFileSync(
    join(data, ".openmapx-builds/otp.json"),
    JSON.stringify({
      schemaVersion: 1,
      service: "otp",
      builtAt: new Date().toISOString(),
      runtimeImages: { otp: "example.test/otp@sha256:" + "a".repeat(64) },
      toolImages: {},
    }),
  );
  expect((await inspectDataInventory(root)).builds.find((x) => x.target === "otp")).toMatchObject({
    readiness: "unknown",
    buildRecordVersion: 1,
    built: false,
  });
});
it("surfaces unsafe OSM directories as unavailable, without exposing host paths", async () => {
  const { root, data } = fixture();
  renameSync(join(data, "osm"), join(data, "saved"));
  writeFileSync(join(data, "osm"), "not a directory");
  const result = await inspectDataInventory(root);
  expect(result.osm).toMatchObject({ unavailable: true, items: [] });
  expect(JSON.stringify(result)).not.toContain(root);
});
it.each(["output", "source"] as const)(
  "invalidates same-size %s replacement without hashing on poll",
  async (changed) => {
    const { root, data } = fixture();
    const { capturePreparedBuildEvidence, hashDataFile, osmArtifactId } = await import(
      "@openmapx/core/build-artifacts"
    );
    mkdirSync(join(data, "osrm-graph"));
    for (const file of [
      "region.osrm",
      "region.osrm.partition",
      "region.osrm.cells",
      "region.osrm.mldgr",
    ])
      writeFileSync(join(data, "osrm-graph", file), "graph bytes");
    const path = "osm/europe-germany.osm.pbf";
    writeFileSync(join(data, path), "pbf bytes");
    const source = await hashDataFile(join(data, path));
    const record = await capturePreparedBuildEvidence({
      dataRoot: data,
      record: {
        schemaVersion: 2,
        service: "osrm",
        builtAt: new Date().toISOString(),
        region: "europe/germany",
        sourcePbf: { name: "europe-germany.osm.pbf", sizeBytes: source.sizeBytes },
        runtimeImages: { osrm: "example.test/osrm@sha256:" + "a".repeat(64) },
        toolImages: {},
        sourceFingerprints: [
          {
            id: osmArtifactId("europe-germany.osm.pbf"),
            sha256: source.sha256,
            sizeBytes: source.sizeBytes,
          },
        ],
        artifactFingerprint: "0".repeat(64),
      },
      inputs: [
        {
          path,
          sha256: source.sha256,
          device: source.device,
          inode: source.inode,
          sizeBytes: source.sizeBytes,
          modifiedAtMs: source.modifiedAtMs,
          changedAtMs: source.changedAtMs,
        },
      ],
    });
    writeFileSync(join(data, ".openmapx-builds/osrm.json"), JSON.stringify(record));
    expect(
      (await inspectDataInventory(root)).builds.find((x) => x.target === "osrm"),
    ).toMatchObject({
      built: true,
      readiness: "ready",
      buildRecordVersion: 2,
      region: "europe/germany",
    });
    const replaced = join(data, changed === "output" ? "osrm-graph/region.osrm" : path),
      bytes = changed === "output" ? "other bytes" : "new bytes";
    writeFileSync(replaced + ".replacement", bytes);
    renameSync(replaced + ".replacement", replaced);
    expect(
      (await inspectDataInventory(root)).builds.find((x) => x.target === "osrm"),
    ).toMatchObject({ built: false, readiness: "stale" });
  },
);
it("invalidates a download fingerprint after same-size inode replacement", async () => {
  const { root, data } = fixture();
  const { fileIdentity, osmArtifactId } = await import("@openmapx/core/build-artifacts");
  const { lstatSync } = await import("node:fs");
  const name = "europe-germany.osm.pbf",
    path = join(data, "osm", name);
  writeFileSync(path, "before");
  writeFileSync(
    path + ".openmapx.json",
    JSON.stringify({
      schemaVersion: 1,
      artifactId: osmArtifactId(name),
      region: "europe/germany",
      sha256: "c".repeat(64),
      ...fileIdentity(lstatSync(path, { bigint: true })),
    }),
  );
  expect((await inspectDataInventory(root)).osm.items[0]).toMatchObject({
    fingerprintState: "verified",
    sourceFingerprint: "c".repeat(64),
  });
  writeFileSync(path + ".replacement", "after!");
  renameSync(path + ".replacement", path);
  expect((await inspectDataInventory(root)).osm.items[0]).toMatchObject({
    fingerprintState: "stale",
    sourceFingerprint: null,
  });
});
it("does not silently truncate extracts at the previous first page", async () => {
  const { root, data } = fixture();
  for (let i = 0; i < 501; i++)
    writeFileSync(join(data, "osm", `${String(i).padStart(4, "0")}.osm.pbf`), "x");
  const page = await inspectDataInventory(root, { osmOffset: 500, osmLimit: 50 });
  expect(page.osm).toMatchObject({ total: 501, offset: 500, unavailable: false });
  expect(page.osm.items.map((x) => x.filename)).toEqual(["0500.osm.pbf"]);
});
it("checks changed source evidence even outside the displayed OSM page", async () => {
  const { root, data } = fixture();
  const { capturePreparedBuildEvidence, fileIdentity, osmArtifactId } = await import(
    "@openmapx/core/build-artifacts"
  );
  const { lstatSync } = await import("node:fs");
  mkdirSync(join(data, "otp-graph"));
  writeFileSync(join(data, "otp-graph/graph.obj"), "graph");
  for (let i = 0; i < 50; i++) writeFileSync(join(data, "osm", `a${i}.osm.pbf`), "x");
  const name = "zz.osm.pbf",
    path = join(data, "osm", name);
  writeFileSync(path, "new source");
  writeFileSync(
    path + ".openmapx.json",
    JSON.stringify({
      schemaVersion: 1,
      artifactId: osmArtifactId(name),
      region: "zz",
      sha256: "d".repeat(64),
      ...fileIdentity(lstatSync(path, { bigint: true })),
    }),
  );
  const record = await capturePreparedBuildEvidence({
    dataRoot: data,
    record: {
      schemaVersion: 2,
      service: "otp",
      builtAt: new Date().toISOString(),
      sourcePbf: { name, sizeBytes: 10 },
      runtimeImages: { otp: "example.test/otp" },
      toolImages: {},
      sourceFingerprints: [{ id: osmArtifactId(name), sha256: "e".repeat(64), sizeBytes: 10 }],
      artifactFingerprint: "0".repeat(64),
    },
  });
  writeFileSync(join(data, ".openmapx-builds/otp.json"), JSON.stringify(record));
  const inventory = await inspectDataInventory(root);
  expect(inventory.osm.items).toHaveLength(50);
  expect(inventory.osm.items.some((item) => item.filename === name)).toBe(false);
  expect(inventory.builds.find((item) => item.target === "otp")).toMatchObject({
    built: false,
    readiness: "stale",
  });
});
it("reports a disappeared listed extract as unavailable, not an empty successful scan", async () => {
  const { root, data } = fixture(),
    file = join(data, "osm/vanishing.osm.pbf");
  writeFileSync(file, "bytes");
  const { AnchoredDirectory } = await import(
    "../../../packages/core/src/build-artifacts/filesystem"
  );
  const { unlinkSync } = await import("node:fs");
  const { vi } = await import("vitest");
  const list = AnchoredDirectory.prototype.listBounded;
  const spy = vi.spyOn(AnchoredDirectory.prototype, "listBounded").mockImplementation(function (
    this: InstanceType<typeof AnchoredDirectory>,
    maximum: number,
  ) {
    const names = list.call(this, maximum);
    if (this.path.endsWith("/osm") && names.includes("vanishing.osm.pbf")) unlinkSync(file);
    return names;
  });
  try {
    expect((await inspectDataInventory(root)).osm).toMatchObject({ unavailable: true, items: [] });
  } finally {
    spy.mockRestore();
  }
});
it("preserves the legacy top-level extract fallback when managed OSM storage is absent", async () => {
  const { root, data } = fixture();
  rmSync(join(data, "osm"), { recursive: true });
  writeFileSync(join(data, "legacy-latest.osm.pbf"), "legacy");
  expect((await inspectDataInventory(root)).osm).toMatchObject({
    unavailable: false,
    total: 1,
    items: [{ filename: "legacy-latest.osm.pbf", fingerprintState: "missing", region: null }],
  });
});
