import { classifyProviderFailure, ProviderRetiredError } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }));

vi.mock("../registry.js", () => ({
  registry: { replaceWith: vi.fn(), startRefresh: vi.fn(() => () => {}) },
  RegistryManager: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    snapshotEntries = () => [
      {
        id: "us/test-otp",
        prefix: "tst:",
        protocol: "otpGraphQl",
        coverage: { bbox: [0, 0, 1, 1], tiers: [] },
      },
    ];
  },
}));
vi.mock("../adapters.js", () => ({
  getAdapter: (_protocol: string, otp: { signal: AbortSignal }) => {
    captured.signal = otp.signal;
    return null;
  },
}));

import { setup } from "../index.js";

it("retires its adapters with a cancellation that provider health never records", async () => {
  const handlers: Array<() => Promise<void>> = [];
  const ctx = createMockIntegrationContext({ config: {} });
  ctx.onShutdown = (handler) => handlers.push(handler);

  await setup(ctx);
  for (const handler of handlers) await handler();

  expect(captured.signal?.aborted).toBe(true);
  expect(captured.signal?.reason).toBeInstanceOf(ProviderRetiredError);
  expect(classifyProviderFailure(captured.signal?.reason)).toBe("caller_cancelled");
});
