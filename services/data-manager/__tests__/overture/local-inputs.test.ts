/** Producer-contract metadata inspection, not a parquet ingestion proof. */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overtureRecoverySchema } from "@openmapx/core/data-manager-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { captureOvertureCatalogue } from "../../src/jobs/overture/attribution-capture";
import { inspectOvertureLocalInputs } from "../../src/jobs/overture/local-inputs";
import { buildOverturePullContract, pullContractPath } from "../../src/jobs/overture/stac";

const database = vi.hoisted(() => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }) }));
vi.mock("../../src/db/index", () => ({ sql: database.sql, rawSql: database.sql, db: {} }));
vi.mock("../../src/jobs/overture/operation-lock", async (original) => ({
  ...(await original<object>()),
  overtureOperationBusy: async () => false,
}));
vi.mock("../../src/jobs/overture/rebuild-links", async (original) => ({
  ...(await original<object>()),
  getOvertureConflationState: async () => null,
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "omx-overture-inputs-"));
  roots.push(path);
  return path;
}
function snapshot(dataDir: string, release: string) {
  const region = "europe/germany",
    directory = join(dataDir, "overture", release);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const file = join(directory, "europe-germany.parquet");
  writeFileSync(file, "metadata fixture, not a real parquet", { mode: 0o600 });
  const contract = buildOverturePullContract(
    {
      release,
      stacVersion: "1.1.0",
      collectionUrl: `https://stac.overturemaps.org/${release}/places/place/collection.json`,
      assets: [
        {
          itemId: "00001",
          bbox: [5, 30, 20, 60],
          numRows: 200,
          href: `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${release}/theme=places/type=place/part-00001-immutable.parquet`,
        },
      ],
      selectedAssetRows: 200,
    },
    region,
    { west: 5, south: 30, east: 20, north: 60 },
    file,
    { rowCount: 42, contributors: ["meta", "Overture"] },
    undefined,
    captureOvertureCatalogue("2026-10-13T00:00:00.000Z"),
  );
  writeFileSync(pullContractPath(dataDir, release, region), JSON.stringify(contract), {
    mode: 0o600,
  });
  return file;
}
it("selects the newest completed local region contract, ignoring partial pulls without creating files", () => {
  const path = root();
  snapshot(path, "2026-10-01.0");
  const newest = snapshot(path, "2026-10-21.0");
  mkdirSync(join(path, "overture/2026-10-29.0"), { mode: 0o700 });
  writeFileSync(join(path, "overture/2026-10-29.0/europe-germany.parquet"), "incomplete", {
    mode: 0o600,
  });
  mkdirSync(join(path, "osm"), { mode: 0o700 });
  writeFileSync(join(path, "osm/europe-germany.osm.pbf"), "PBF fixture", { mode: 0o600 });
  expect(inspectOvertureLocalInputs(path, "europe/germany")).toEqual({
    downloadedRelease: "2026-10-21.0",
    osmAvailable: true,
    catalogueRefusal: null,
  });
  expect(inspectOvertureLocalInputs(path, "europe/france")).toEqual({
    downloadedRelease: null,
    osmAvailable: false,
    catalogueRefusal: null,
  });
  writeFileSync(newest, "changed size", { mode: 0o600 });
  expect(inspectOvertureLocalInputs(path, "europe/germany").downloadedRelease).toBe("2026-10-01.0");
});
it("reports a complete pull without a valid catalogue instead of skipping to an older release", async () => {
  const path = root();
  snapshot(path, "2026-10-01.0");
  snapshot(path, "2026-10-21.0");
  const contractPath = pullContractPath(path, "2026-10-21.0", "europe/germany");
  const { sourcesCatalogue: _, ...withoutCatalogue } = JSON.parse(
    readFileSync(contractPath, "utf8"),
  );
  writeFileSync(contractPath, JSON.stringify({ ...withoutCatalogue, contractVersion: 1 }), {
    mode: 0o600,
  });
  const refusal =
    "Overture pull contract for 2026-10-21.0/europe/germany has no valid sources catalogue; re-pull the release so its places keep their attribution";
  expect(inspectOvertureLocalInputs(path, "europe/germany")).toEqual({
    downloadedRelease: null,
    osmAvailable: false,
    catalogueRefusal: refusal,
  });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("Unexpected network release discovery"));
  const { ingestOverture } = await import("../../src/jobs/overture/ingest");
  await expect(ingestOverture({ dataDir: path, region: "europe/germany" })).rejects.toThrow(
    refusal,
  );
  const { assertOvertureRecoveryInputs, inspectOvertureRecovery } = await import(
    "../../src/jobs/overture/recovery"
  );
  await expect(
    assertOvertureRecoveryInputs(path, "europe/germany", "overture-ingest"),
  ).rejects.toThrow(refusal);
  const status = await inspectOvertureRecovery(path, "europe/germany");
  expect(status.downloadedRelease).toBeNull();
  expect(status.actions["overture-ingest"]).toEqual({ allowed: false, reason: refusal });
  expect(overtureRecoverySchema.parse(status)).toEqual(status);
  expect(fetch).not.toHaveBeenCalled();
  expect(database.sql.unsafe).not.toHaveBeenCalled();
});
it("does not follow a release directory symlink or accept traversal regions", () => {
  const path = root(),
    outside = root();
  mkdirSync(join(path, "overture"), { mode: 0o700 });
  symlinkSync(outside, join(path, "overture/2026-10-21.0"));
  expect(() => inspectOvertureLocalInputs(path, "europe/germany")).toThrow();
  expect(() => inspectOvertureLocalInputs(path, "../outside")).toThrow();
});
it("refuses standalone ingest without a completed local download before network or database work", async () => {
  const path = root(),
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("Unexpected network release discovery"));
  const { ingestOverture } = await import("../../src/jobs/overture/ingest");
  await expect(ingestOverture({ dataDir: path, region: "europe/germany" })).rejects.toThrow(
    /completed local Overture partition/,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(database.sql.unsafe).not.toHaveBeenCalled();
  expect(readdirSync(path)).toEqual([]);
});
