import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

interface Captured {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/** A reply double capturing status/send/header for a registered route handler. */
function fakeReply(): { reply: unknown; captured: Captured } {
  const captured: Captured = { status: 200, body: undefined, headers: {} };
  const reply = {
    send: (data: unknown) => {
      captured.body = data;
    },
    status: (code: number) => {
      captured.status = code;
      return {
        send: (data: unknown) => {
          captured.body = data;
        },
      };
    },
    header: (name: string, value: string) => {
      captured.headers[name] = value;
    },
    type: () => {},
  };
  return { reply, captured };
}

function routesOf() {
  const ctx = createMockIntegrationContext({ id: "crowd-reports" });
  setup(ctx);
  const byKey = new Map<string, (typeof ctx.registered.routes)[number]>();
  for (const r of ctx.registered.routes) byKey.set(`${r.method} ${r.path}`, r);
  return byKey;
}

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crowd-reports setup", () => {
  it("registers the five relay routes", () => {
    const routes = routesOf();
    expect([...routes.keys()].sort()).toEqual(
      [
        "GET /issuer-keys",
        "POST /enroll",
        "POST /reports",
        "POST /reports/:id/:action",
        "POST /tokens",
      ].sort(),
    );
  });

  it("POST /reports forwards the signed body to the contributions-api and passes status through", async () => {
    const fetchMock = fakeFetch(201, { id: "r1" });
    vi.stubGlobal("fetch", fetchMock);
    const handler = routesOf().get("POST /reports")!.handler;
    const { reply, captured } = fakeReply();

    await handler(
      { query: {}, params: {}, body: { alg: "ES256", signature: "sig", claim: {} } },
      reply as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/contrib/reports");
    expect(init.body).toBe(JSON.stringify({ alg: "ES256", signature: "sig", claim: {} }));
    expect(captured.status).toBe(201);
    expect(captured.body).toEqual({ id: "r1" });
  });

  it("POST /reports/:id/:action rejects an unknown action before relaying", async () => {
    const fetchMock = fakeFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const handler = routesOf().get("POST /reports/:id/:action")!.handler;
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: { id: "r1", action: "delete" }, body: {} }, reply as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured.status).toBe(400);
  });

  it("POST /reports/:id/:action rejects a path-traversal id before relaying", async () => {
    const fetchMock = fakeFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const handler = routesOf().get("POST /reports/:id/:action")!.handler;
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: { id: "..", action: "confirm" }, body: {} }, reply as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured.status).toBe(400);
  });

  it("POST /reports/:id/:action relays a valid confirm to the encoded path", async () => {
    const fetchMock = fakeFetch(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const handler = routesOf().get("POST /reports/:id/:action")!.handler;
    const { reply, captured } = fakeReply();

    await handler(
      { query: {}, params: { id: "crowd:a b", action: "confirm" }, body: { subClaim: {} } },
      reply as never,
    );

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/contrib/reports/crowd%3Aa%20b/confirm");
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true });
  });

  it("GET /issuer-keys does not cache a non-2xx upstream response", async () => {
    const fetchMock = fakeFetch(503, { error: "down" });
    vi.stubGlobal("fetch", fetchMock);
    const handler = routesOf().get("GET /issuer-keys")!.handler;
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: {}, body: undefined }, reply as never);

    expect(captured.status).toBe(503);
    expect(captured.headers["Cache-Control"]).toBe("no-cache");
  });

  it("returns 502 when the contributions service is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = routesOf().get("POST /enroll")!.handler;
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: {}, body: {} }, reply as never);
    expect(captured.status).toBe(502);
  });
});
