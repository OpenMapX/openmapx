import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOvertureDiskCapacity,
  estimateOvertureIngestBytes,
  estimateOverturePullBytes,
  POSTGIS_CONTAINER,
  parsePosixDfAvailableBytes,
} from "../../src/jobs/overture/capacity.js";

describe("Overture capacity preflight", () => {
  const previousReserve = process.env.OVERTURE_DISK_RESERVE_BYTES;

  afterEach(() => {
    if (previousReserve === undefined) delete process.env.OVERTURE_DISK_RESERVE_BYTES;
    else process.env.OVERTURE_DISK_RESERVE_BYTES = previousReserve;
  });

  it("fails with an actionable working-space and reserve calculation", () => {
    process.env.OVERTURE_DISK_RESERVE_BYTES = "100";
    expect(() =>
      assertOvertureDiskCapacity({
        stage: "test ingest",
        workingBytes: 500,
        freeBytes: 599,
      }),
    ).toThrow(/599 bytes free.*600 required.*500 working.*100 safety reserve/);
  });

  it("uses the largest previous regional parquet as the next-pull estimate", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-capacity-"));
    const previousFirstPull = process.env.OVERTURE_FIRST_PULL_ESTIMATE_BYTES;
    try {
      process.env.OVERTURE_FIRST_PULL_ESTIMATE_BYTES = "100";
      const releaseDir = join(dataDir, "overture", "2026-07-22.0");
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, "europe-germany.parquet"), Buffer.alloc(1_000));
      expect(estimateOverturePullBytes(dataDir, "europe-germany")).toBe(1_500);
    } finally {
      if (previousFirstPull === undefined) delete process.env.OVERTURE_FIRST_PULL_ESTIMATE_BYTES;
      else process.env.OVERTURE_FIRST_PULL_ESTIMATE_BYTES = previousFirstPull;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("budgets for the larger of parquet expansion and active-schema replacement", () => {
    expect(estimateOvertureIngestBytes(3_000_000_000, 2_000_000_000)).toBe(12_000_000_000);
    expect(estimateOvertureIngestBytes(1_000_000_000, 8_000_000_000)).toBe(12_000_000_000);
  });

  it("parses POSIX df output from the PostgreSQL container in bytes", () => {
    expect(
      parsePosixDfAvailableBytes(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb 100000 20000 80000 20% /var/lib/postgresql",
      ),
    ).toBe(81_920_000);
  });

  it("pins the PostGIS container name used by the capacity probe", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..", "..");
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "services", "postgis", "service.json"), "utf8"),
    ) as { container?: { containerName?: string } };
    expect(manifest.container?.containerName).toBe(POSTGIS_CONTAINER);
  });
});
