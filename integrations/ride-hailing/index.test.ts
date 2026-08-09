import type { RideProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";

const freshness = {
  fetchedAt: "2026-08-09T00:00:00.000Z",
  hasRealtimeData: false,
  isStale: false,
};

const provider: RideProvider = {
  id: "uber",
  meta: { name: "Uber", homepage: "https://www.uber.com/", sourceId: "uber" },
  capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
  permitsComparison: false,
  attribution: [{ sourceId: "uber", name: "Uber" }],
  getAvailability: async () => ({
    data: { available: true, coverageChecked: false, products: [] },
    attributions: [],
    freshness,
  }),
  createHandoff: () => ({ webUrl: "https://m.uber.com/looking?x=1", carriesCoordinates: true }),
};

function host(config: Record<string, unknown> = {}) {
  const ctx = createMockIntegrationContext({ id: "ride-hailing", config });
  ctx.getIntegrationsByDomain = ((domain: string) =>
    domain === "ride-hailing"
      ? [{ id: "ride-deeplink", providers: new Map([["ride-hailing", [provider]]]) }]
      : []) as typeof ctx.getIntegrationsByDomain;
  setup(ctx);
  const route = (method: string, path: string) => {
    const found = ctx.registered.routes.find((r) => r.method === method && r.path === path);
    if (!found) throw new Error(`route not registered: ${method} ${path}`);
    return found.handler;
  };
  return { ctx, route };
}

function reply() {
  const headers: Record<string, string> = {};
  const state: { code: number; body: unknown } = { code: 200, body: undefined };
  return {
    headers,
    state,
    send: (data: unknown) => {
      state.body = data;
    },
    status: (code: number) => {
      state.code = code;
      return {
        send: (data: unknown) => {
          state.body = data;
        },
      };
    },
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    type: () => {},
  };
}

const pickupQuery = { pickupLat: "52.52", pickupLng: "13.405" };

describe("GET /providers", () => {
  it("lists available providers with the comparison policy", async () => {
    const { route } = host();
    const r = reply();
    await route("GET", "/providers")({ query: pickupQuery, params: {}, body: null }, r);
    const body = r.state.body as { providers: { id: string }[]; comparison: { allowed: boolean } };
    expect(body.providers.map((p) => p.id)).toEqual(["uber"]);
    expect(body.comparison.allowed).toBe(false);
  });

  it("400s on a missing pickup", async () => {
    const { route } = host();
    const r = reply();
    await route("GET", "/providers")({ query: {}, params: {}, body: null }, r);
    expect(r.state.code).toBe(400);
  });
});

describe("POST /quotes", () => {
  it("marks the response as never cacheable", async () => {
    const { route } = host();
    const r = reply();
    await route("POST", "/quotes")(
      { query: {}, params: {}, body: { ...pickupQuery, providerIds: ["uber"] } },
      r,
    );
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("400s when several providers are requested while comparison is locked", async () => {
    const { route } = host();
    const r = reply();
    await route("POST", "/quotes")(
      { query: {}, params: {}, body: { ...pickupQuery, providerIds: ["uber", "lyft"] } },
      r,
    );
    expect(r.state.code).toBe(400);
  });
});

describe("GET /:provider/open", () => {
  it("302s to the provider handoff URL", async () => {
    const { route } = host();
    const r = reply();
    await route("GET", "/:provider/open")(
      { query: pickupQuery, params: { provider: "uber" }, body: null },
      r,
    );
    expect(r.state.code).toBe(302);
    expect(r.headers.Location).toBe("https://m.uber.com/looking?x=1");
  });

  it("404s on an unknown provider", async () => {
    const { route } = host();
    const r = reply();
    await route("GET", "/:provider/open")(
      { query: pickupQuery, params: { provider: "nope" }, body: null },
      r,
    );
    expect(r.state.code).toBe(404);
  });
});

describe("GET /:provider/handoff", () => {
  it("returns the handoff as JSON", async () => {
    const { route } = host();
    const r = reply();
    await route("GET", "/:provider/handoff")(
      { query: pickupQuery, params: { provider: "uber" }, body: null },
      r,
    );
    const body = r.state.body as { handoff: { webUrl: string } };
    expect(body.handoff.webUrl).toBe("https://m.uber.com/looking?x=1");
  });
});
