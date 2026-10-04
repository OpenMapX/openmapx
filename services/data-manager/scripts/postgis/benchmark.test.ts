import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkOptions, fixtureChecksum, requireCompleteReport, writeReports } from "./report";

describe("benchmark isolation and reports", () => {
  it("accepts only smoke and output options and rejects external targets", () => {
    expect(benchmarkOptions(["--smoke", "--output", "/tmp/results"])).toEqual({
      smoke: true,
      output: "/tmp/results",
    });
    expect(() => benchmarkOptions(["--database-url", "postgres://private"])).toThrow();
    expect(() => benchmarkOptions(["--output"])).toThrow();
  });
  it("versions deterministic fixtures and distinguishes sizes", () => {
    expect(fixtureChecksum(1000, 1000)).toBe(fixtureChecksum(1000, 1000));
    expect(fixtureChecksum(1000, 1000)).not.toBe(fixtureChecksum(100000, 10000));
  });
  it("refuses partial reports and missing instrumentation", () => {
    expect(() => requireCompleteReport([])).toThrow();
    expect(() =>
      requireCompleteReport([
        { workload: "search", concurrency: 1, samples: 100, resources: { sampleCount: 0 } },
      ] as never),
    ).toThrow();
  });
});

it("publishes a complete report pair atomically and preserves existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "postgis-report-test-"));
  const output = join(directory, "result");
  try {
    writeReports(output, "{}\n", "report\n");
    expect(readFileSync(join(output, "postgis-baseline.md"), "utf8")).toBe("report\n");
    expect(() => writeReports(output, "changed", "changed")).toThrow();
    expect(readFileSync(join(output, "postgis-baseline.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(directory, "missing"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
