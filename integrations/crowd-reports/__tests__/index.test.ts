import type { HttpClient } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  type FakeHttpClient,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
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

function routesOf(http?: HttpClient) {
  const ctx = createMockIntegrationContext({ id: "crowd-reports", http });
  setup(ctx);
  const byKey = new Map<string, (typeof ctx.registered.routes)[number]>();
  for (const r of ctx.registered.routes) byKey.set(`${r.method} ${r.path}`, r);
  return byKey;
}

/** Resolves a registered route's handler, failing loudly when the route is missing. */
function handlerFor(key: string, http: HttpClient) {
  const route = routesOf(http).get(key);
  if (!route) throw new Error(`no route registered for ${key}`);
  return route.handler;
}

/** A host client whose every relay answers with this upstream status + JSON body. */
function upstream(status: number, body: unknown): FakeHttpClient {
  return fakeHttpClient(() => ({ status, headers: {}, body }));
}

describe("crowd-reports setup", () => {
  it("registers the five relay routes", () => {
    const routes = routesOf();
    expect([...routes.keys()].sort()).toEqual(
      [
        "GET /issuer-keys",
        "POST /enroll",
        "POST /reports",
        "POST /reports/:class/:id/:action",
        "POST /tokens",
      ].sort(),
    );
  });

  it("POST /reports forwards the signed body to the contributions-api and passes status through", async () => {
    const http = upstream(201, { id: "r1" });
    const handler = handlerFor("POST /reports", http);
    const { reply, captured } = fakeReply();

    await handler(
      { query: {}, params: {}, body: { alg: "ES256", signature: "sig", claim: {} } },
      reply as never,
    );

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.method).toBe("postResponse");
    expect(http.calls[0]?.url).toContain("/contrib/reports");
    expect(http.calls[0]?.body).toEqual({ alg: "ES256", signature: "sig", claim: {} });
    expect(captured.status).toBe(201);
    expect(captured.body).toEqual({ id: "r1" });
  });

  it.each([
    ["an unknown action", { class: "situation", id: "r1", action: "delete" }, {}],
    ["an unknown record class", { class: "report", id: "r1", action: "confirm" }, {}],
    ["a path-traversal class", { class: "..", id: "r1", action: "confirm" }, {}],
    ["a path-traversal id", { class: "situation", id: "..", action: "confirm" }, {}],
    [
      "a repeated component",
      { class: "feature", id: "f1", action: "confirm" },
      { component: ["a", "b"] },
    ],
    ["an empty component", { class: "feature", id: "f1", action: "confirm" }, { component: "" }],
  ])("POST /reports/:class/:id/:action rejects %s before relaying", async (_, params, query) => {
    const http = upstream(200, {});
    const handler = handlerFor("POST /reports/:class/:id/:action", http);
    const { reply, captured } = fakeReply();

    await handler({ query, params, body: {} }, reply as never);

    expect(http.calls).toHaveLength(0);
    expect(captured.status).toBe(400);
  });

  it("POST /reports/:class/:id/:action relays a valid confirm to the encoded path", async () => {
    const http = upstream(200, { record: { class: "situation", id: "s 1" } });
    const handler = handlerFor("POST /reports/:class/:id/:action", http);
    const { reply, captured } = fakeReply();

    await handler(
      {
        query: {},
        params: { class: "situation", id: "crowd:a b", action: "confirm" },
        body: { subClaim: {} },
      },
      reply as never,
    );

    expect(http.calls[0]?.url).toMatch(/\/contrib\/reports\/situation\/crowd%3Aa%20b\/confirm$/);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ record: { class: "situation", id: "s 1" } });
  });

  it("POST /reports/:class/:id/:action passes a feature component through", async () => {
    const http = upstream(422, { reason: "unsupported_record_class" });
    const handler = handlerFor("POST /reports/:class/:id/:action", http);
    const { reply, captured } = fakeReply();

    await handler(
      {
        query: { component: "lane 1&x=y" },
        params: { class: "feature", id: "f1", action: "negate" },
        body: { subClaim: {} },
      },
      reply as never,
    );

    expect(http.calls[0]?.url).toMatch(
      /\/contrib\/reports\/feature\/f1\/negate\?component=lane%201%26x%3Dy$/,
    );
    expect(captured.status).toBe(422);
    expect(captured.body).toEqual({ reason: "unsupported_record_class" });
  });

  it("GET /issuer-keys does not cache a non-2xx upstream response", async () => {
    const http = upstream(503, { error: "down" });
    const handler = handlerFor("GET /issuer-keys", http);
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: {}, body: undefined }, reply as never);

    expect(http.calls[0]?.method).toBe("getResponse");
    expect(captured.status).toBe(503);
    expect(captured.headers["Cache-Control"]).toBe("no-cache");
  });

  it("returns 502 when the contributions service is unreachable", async () => {
    const http = fakeHttpClient(() => {
      throw new Error("ECONNREFUSED");
    });
    const handler = handlerFor("POST /enroll", http);
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: {}, body: {} }, reply as never);
    expect(captured.status).toBe(502);
  });

  it("returns 502 rather than relaying an answer the host client refuses", async () => {
    const http = fakeHttpClient(() => {
      throw new Error("integration HTTP response has unexpected content type");
    });
    const handler = handlerFor("POST /tokens", http);
    const { reply, captured } = fakeReply();

    await handler({ query: {}, params: {}, body: {} }, reply as never);
    expect(captured.status).toBe(502);
    expect(captured.body).toEqual({ error: "contributions service unavailable" });
  });
});
