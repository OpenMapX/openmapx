import { beforeEach, describe, expect, it, vi } from "vitest";

// The build/validate/chown/restart sequence moved into the operations agent
// (see apps/ops-agent/src/docker-runtime.test.ts, which owns those cases).
// What data-manager still owns is the decision to ask for a rebuild at all, so
// that is what this suite covers.
const runOpsOperation = vi.fn();
vi.mock("../ops-client.js", () => ({
  runOpsOperation: (operation: unknown) => runOpsOperation(operation),
}));

const { ensureTrafficExtract, isTrafficExtractStale } = await import(
  "../jobs/traffic/ensure-extract.js"
);

describe("ensureTrafficExtract", () => {
  beforeEach(() => {
    runOpsOperation.mockReset();
  });

  it("inspects first and rebuilds only when the extract is not ready", async () => {
    runOpsOperation
      .mockResolvedValueOnce({ state: "not_ready" })
      .mockResolvedValueOnce({ changed: true });

    await expect(ensureTrafficExtract()).resolves.toEqual({ built: true });
    expect(runOpsOperation.mock.calls.map(([operation]) => operation)).toEqual([
      { kind: "valhalla.traffic.inspect" },
      { kind: "valhalla.traffic.rebuild" },
    ]);
  });

  it("does not rebuild when the extract is already ready", async () => {
    runOpsOperation.mockResolvedValueOnce({ state: "ready" });

    await expect(ensureTrafficExtract()).resolves.toEqual({ built: false });
    expect(runOpsOperation).toHaveBeenCalledTimes(1);
  });

  it("skips the readiness check entirely when force is set", async () => {
    runOpsOperation.mockResolvedValueOnce({ changed: true });

    await expect(ensureTrafficExtract({ force: true })).resolves.toEqual({ built: true });
    expect(runOpsOperation.mock.calls.map(([operation]) => operation)).toEqual([
      { kind: "valhalla.traffic.rebuild" },
    ]);
  });

  it("propagates a failed rebuild rather than reporting success", async () => {
    runOpsOperation
      .mockResolvedValueOnce({ state: "not_ready" })
      .mockRejectedValueOnce(new Error("Operation valhalla.traffic.rebuild did not succeed"));

    await expect(ensureTrafficExtract()).rejects.toThrow(/did not succeed/);
  });

  it("names no container, config path, or argv in any request", async () => {
    runOpsOperation
      .mockResolvedValueOnce({ state: "not_ready" })
      .mockResolvedValueOnce({ changed: true });

    await ensureTrafficExtract();
    const serialized = JSON.stringify(runOpsOperation.mock.calls);
    for (const forbidden of ["docker-valhalla-1", "/custom_files", "valhalla_build_extract"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("isTrafficExtractStale", () => {
  beforeEach(() => {
    runOpsOperation.mockReset();
  });

  it("is stale when the agent reports the extract is not ready", async () => {
    runOpsOperation.mockResolvedValueOnce({ state: "not_ready" });
    await expect(isTrafficExtractStale()).resolves.toBe(true);
  });

  it("is not stale when the agent reports it ready", async () => {
    runOpsOperation.mockResolvedValueOnce({ state: "ready" });
    await expect(isTrafficExtractStale()).resolves.toBe(false);
  });

  it("does not force a rebuild on an inconclusive observation", async () => {
    // `unknown` means the agent could not read the tile directory while an
    // extract exists. Rebuilding on that would bounce Valhalla for nothing.
    runOpsOperation.mockResolvedValueOnce({ state: "unknown" });
    await expect(isTrafficExtractStale()).resolves.toBe(false);
  });
});
