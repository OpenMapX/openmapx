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
});
