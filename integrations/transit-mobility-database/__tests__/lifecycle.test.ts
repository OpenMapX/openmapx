import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { isMdbConfigured, setup } from "../index";

function context(
  token: string,
  activate: (handler: () => void) => void,
  shutdown: Array<() => Promise<void>>,
): IntegrationContext {
  return {
    config: { refreshToken: token },
    cache: {},
    log: { warn: vi.fn() },
    registerGtfsCatalogProvider: vi.fn(),
    onActivate: activate,
    onShutdown: (handler: () => Promise<void>) => shutdown.push(handler),
  } as unknown as IntegrationContext;
}

describe("Mobility Database generation lifecycle", () => {
  it("does not let retirement of the old generation clear the active client", async () => {
    const oldShutdown: Array<() => Promise<void>> = [];
    await setup(context("old-token", (handler) => handler(), oldShutdown));
    expect(isMdbConfigured()).toBe(true);

    const activations: Array<() => void> = [];
    await setup(context("new-token", (handler) => activations.push(handler), []));
    expect(isMdbConfigured()).toBe(true);

    for (const activate of activations) activate();
    await oldShutdown[0]?.();

    expect(isMdbConfigured()).toBe(true);
  });
});
