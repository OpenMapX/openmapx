import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({
  release: vi.fn(),
  startBackgroundLoad: vi.fn(),
}));

vi.mock("@openmapx/ourairports-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/ourairports-data")>()),
  startBackgroundLoad: loader.startBackgroundLoad,
}));

import { setup } from "./index.js";

describe("OurAirports overlay lifecycle", () => {
  it("registers shutdown ownership for its shared background loader", () => {
    loader.startBackgroundLoad.mockReturnValueOnce(loader.release);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const ctx = createMockIntegrationContext();
    ctx.onShutdown = (handler) => shutdownHandlers.push(handler);

    setup(ctx);

    expect(shutdownHandlers).toHaveLength(1);
    void shutdownHandlers[0]();
    expect(loader.release).toHaveBeenCalledTimes(1);
  });
});
