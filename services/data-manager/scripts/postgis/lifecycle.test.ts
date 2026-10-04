import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ operation: vi.fn(), stop: vi.fn(), stats: vi.fn() }));
vi.mock("./container", () => ({
  startBenchmarkDatabase: async () => ({
    metadata: {},
    stop: mocks.stop,
    raw: { stats: mocks.stats },
    sql: {
      unsafe: async () => [
        {
          checksum: "synthetic",
          waiting: "0",
          "QUERY PLAN": [{ Plan: { "Node Type": "Result", "Actual Rows": 1 } }],
        },
      ],
      begin: async (callback: (sql: unknown) => Promise<unknown>) =>
        callback({
          unsafe: async () => [
            { "QUERY PLAN": [{ Plan: { "Node Type": "Result", "Actual Rows": 1 } }] },
          ],
        }),
    },
  }),
}));
vi.mock("../../src/postgis/diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/postgis/diagnostics")>()),
  collectDiagnostics: async () => ({
    settings: {},
    statsReset: null,
    statementCount: "1",
    deallocations: "0",
    statements: [],
  }),
}));
vi.mock("./workloads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workloads")>()),
  createFixture: async () => {},
  resetMutation: async () => {},
  runOperation: mocks.operation,
}));

import { runBenchmark } from "./benchmark";

beforeEach(() => {
  vi.clearAllMocks();
  let counter = 0;
  mocks.stats.mockImplementation(async () => ({
    cpu_stats: {
      cpu_usage: { total_usage: ++counter * 100 },
      system_cpu_usage: counter * 1000,
      online_cpus: 2,
    },
    memory_stats: { usage: 1024 },
  }));
  mocks.operation.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
});
it("rejects cancellation during the final operation and cleans up", async () => {
  const controller = new AbortController();
  let operations = 0;
  mocks.operation.mockImplementation(async () => {
    if (++operations === 170) controller.abort();
  });
  await expect(runBenchmark({ smoke: true, signal: controller.signal })).rejects.toThrow();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it("rejects cancellation during final container teardown", async () => {
  const controller = new AbortController();
  mocks.stop.mockImplementation(async () => controller.abort());
  await expect(runBenchmark({ smoke: true, signal: controller.signal })).rejects.toThrow();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it("cleans up instead of succeeding when resource acquisition fails", async () => {
  mocks.stats.mockRejectedValue(new Error("sampling failure"));
  await expect(runBenchmark({ smoke: true })).rejects.toThrow("sampling failure");
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it("preserves an in-flight sampler failure during worker teardown", async () => {
  let observations = 0,
    operations = 0;
  const normalStats = mocks.stats.getMockImplementation();
  mocks.stats.mockImplementation(async () => {
    if (++observations === 2) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("in-flight sampling failure");
    }
    return normalStats?.();
  });
  mocks.operation.mockImplementation(async () => {
    if (++operations === 6) await new Promise((resolve) => setTimeout(resolve, 130));
  });
  await expect(runBenchmark({ smoke: true })).rejects.toThrow("in-flight sampling failure");
  expect(mocks.stop).toHaveBeenCalledOnce();
});
