import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";

const registryMock = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  listEntries: vi.fn().mockReturnValue([]),
  releases: [vi.fn(), vi.fn()],
  startRefresh: vi.fn(),
  stopRefresh: vi.fn(),
  replaceWith: vi.fn(),
}));
const hafasMock = vi.hoisted(() => ({ setRedis: vi.fn() }));

vi.mock("../registry.js", () => ({
  registry: registryMock,
  RegistryManager: class {
    initialize = registryMock.initialize;
    listEntries = registryMock.listEntries;
  },
}));
vi.mock("../hafas-mgate.js", () => ({
  hafasMgateAdapter: {},
  setRedis: hafasMock.setRedis,
}));

import { setup } from "../index.js";

describe("dynamic transit registry lifecycle", () => {
  it("clears the retired Redis adapter when the replacement has no Redis configuration", async () => {
    const context = createMockIntegrationContext({ config: {} });

    await setup(context);

    expect(hafasMock.setRedis).toHaveBeenCalledWith(null);
  });

  it("shutdown releases only the refresh ownership acquired by that setup", async () => {
    registryMock.startRefresh
      .mockReturnValueOnce(registryMock.releases[0])
      .mockReturnValueOnce(registryMock.releases[1]);
    const oldHandlers: Array<() => Promise<void>> = [];
    const newHandlers: Array<() => Promise<void>> = [];
    const oldContext = createMockIntegrationContext();
    const newContext = createMockIntegrationContext();
    oldContext.onShutdown = (handler) => oldHandlers.push(handler);
    newContext.onShutdown = (handler) => newHandlers.push(handler);

    await setup(oldContext);
    await setup(newContext);
    expect(oldHandlers).toHaveLength(1);
    expect(newHandlers).toHaveLength(1);

    await oldHandlers[0]();
    expect(registryMock.releases[0]).toHaveBeenCalledTimes(1);
    expect(registryMock.releases[1]).not.toHaveBeenCalled();
    expect(registryMock.stopRefresh).not.toHaveBeenCalled();
  });
});
