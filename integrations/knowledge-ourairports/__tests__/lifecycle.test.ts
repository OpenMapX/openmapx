import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({
  releases: [vi.fn(), vi.fn()],
  startBackgroundLoad: vi.fn(),
  stopBackgroundLoad: vi.fn(),
}));

vi.mock("@openmapx/ourairports-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/ourairports-data")>()),
  startBackgroundLoad: loader.startBackgroundLoad,
  stopBackgroundLoad: loader.stopBackgroundLoad,
}));

import { setup } from "../index.js";

describe("knowledge OurAirports lifecycle", () => {
  it("shutdown releases only the background-load ownership acquired by that setup", () => {
    loader.startBackgroundLoad
      .mockReturnValueOnce(loader.releases[0])
      .mockReturnValueOnce(loader.releases[1]);
    const oldHandlers: Array<() => Promise<void>> = [];
    const newHandlers: Array<() => Promise<void>> = [];
    const oldContext = createMockIntegrationContext();
    const newContext = createMockIntegrationContext();
    oldContext.onShutdown = (handler) => oldHandlers.push(handler);
    newContext.onShutdown = (handler) => newHandlers.push(handler);

    setup(oldContext);
    setup(newContext);
    expect(oldHandlers).toHaveLength(1);
    expect(newHandlers).toHaveLength(1);

    void oldHandlers[0]();
    expect(loader.releases[0]).toHaveBeenCalledTimes(1);
    expect(loader.releases[1]).not.toHaveBeenCalled();
    expect(loader.stopBackgroundLoad).not.toHaveBeenCalled();
  });

  it("registers ownership cleanup before later setup work can fail", async () => {
    const release = vi.fn();
    loader.startBackgroundLoad.mockReturnValueOnce(release);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const ctx = createMockIntegrationContext();
    ctx.onShutdown = (handler) => shutdownHandlers.push(handler);
    ctx.registerKnowledgeProvider = () => {
      throw new Error("injected provider registration failure");
    };

    expect(() => setup(ctx)).toThrow("injected provider registration failure");
    expect(shutdownHandlers).toHaveLength(1);

    await shutdownHandlers[0]();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
