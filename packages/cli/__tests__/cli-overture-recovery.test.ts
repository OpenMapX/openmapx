/** CLI delegation only; DTO mocks provide no execution/host authority. */
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";

const step = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/data-execution", async (original) => ({
  ...(await original<typeof import("../src/lib/data-execution")>()),
  runCliDataStep: step,
}));

import { registerDataCommands } from "../src/commands/data";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each(["overture-pull", "overture-ingest", "overture-extract"] as const)(
  "routes %s through the original durable data-step owner",
  async (kind) => {
    step.mockResolvedValue({ id: "synthetic-observer-dto" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("unexpected fetch"));
    const app = new Command();
    app.exitOverride();
    registerDataCommands(app);
    await app.parseAsync(["data", kind, "europe/germany"], { from: "user" });
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0]?.[0]).toEqual({ kind, region: "europe/germany" });
    expect(fetch).not.toHaveBeenCalled();
  },
);
