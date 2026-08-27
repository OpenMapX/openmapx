import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

function reply() {
  const send = vi.fn();
  return {
    send,
    status: vi.fn(() => ({ send })),
    header: vi.fn(),
  };
}

describe("search suggestions route", () => {
  it("returns an empty response for a one-character query", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const res = reply();
    await ctx.registered.routes[0].handler(
      { query: { q: "F" }, params: {}, body: undefined, headers: {} },
      res,
    );
    expect(res.send).toHaveBeenCalledWith({
      suggestions: [],
      attributions: [],
      partial: false,
    });
  });

  it("rejects incomplete proximity", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const res = reply();
    await ctx.registered.routes[0].handler(
      { query: { q: "FRA", lat: "50" }, params: {}, body: undefined, headers: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("marks degraded aggregate responses as non-cacheable", async () => {
    const withCache = vi.fn(async () => ({
      suggestions: [{ id: "available", name: "Available" }],
      attributions: [],
      partial: true,
    }));
    const ctx = createMockIntegrationContext({
      cache: {
        get: async () => null,
        set: async () => undefined,
        del: async () => undefined,
        withCache,
      },
    });
    setup(ctx);
    const res = reply();

    await ctx.registered.routes[0].handler(
      { query: { q: "Berlin" }, params: {}, body: undefined, headers: {} },
      res,
    );

    expect(res.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(withCache).toHaveBeenCalledWith(
      expect.any(String),
      300,
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    const shouldCache = withCache.mock.calls[0]?.[4] as
      | ((value: { partial: boolean }) => boolean)
      | undefined;
    expect(shouldCache?.({ partial: true })).toBe(false);
    expect(shouldCache?.({ partial: false })).toBe(true);
  });
});
