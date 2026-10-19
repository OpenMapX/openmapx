import { describe, expect, it, vi } from "vitest";
import type { SwissTransitClient } from "../client.js";
import type { SwissDatasets } from "../datasets.js";
import { createOpenTransportDataChProvider } from "../provider.js";

function providerWithProbe(probe: () => Promise<boolean>) {
  return createOpenTransportDataChProvider({
    client: { probeSwissOjp: probe } as SwissTransitClient,
    datasets: {} as SwissDatasets,
    contributors: {},
  });
}

describe("Swiss provider instance ownership", () => {
  it("keeps a deferred old generation bound to its own client", async () => {
    let resolve!: (value: boolean) => void;
    const firstProbe = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const first = providerWithProbe(firstProbe);
    const pending = first.isOpenTransportDataChAvailable();
    const secondProbe = vi.fn(async () => false);
    const second = providerWithProbe(secondProbe);
    expect(await second.isOpenTransportDataChAvailable()).toBe(false);
    resolve(true);
    expect(await pending).toBe(true);
    expect(firstProbe).toHaveBeenCalledTimes(1);
    expect(secondProbe).toHaveBeenCalledTimes(1);
    await first.dispose();
    expect(await second.isOpenTransportDataChAvailable()).toBe(false);
  });

  it("rejects retired entry points without touching another generation", async () => {
    const probe = vi.fn(async () => true);
    const first = providerWithProbe(probe);
    const second = providerWithProbe(probe);
    await first.dispose();
    await first.dispose();
    await expect(first.isOpenTransportDataChAvailable()).rejects.toThrow(/retired/i);
    expect(await second.isOpenTransportDataChAvailable()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
