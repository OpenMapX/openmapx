import type { TrafficApplicationSnapshot } from "@openmapx/core";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerApi } from "../api.js";
import { registerAuth } from "../auth.js";

const APPLIED: TrafficApplicationSnapshot = {
  schemaVersion: 1,
  mode: "active",
  providerId: "routing-valhalla",
  writeId: "95a348cc-14ba-4823-9e32-c72935188acb",
  engineBootId: "e2630bd0-5a85-4c93-9b7d-cf174bd0dd45",
  graphGeneration: "host-graph",
  policyRevision: "policy",
  validUntil: "2026-09-06T10:01:00Z",
  receipts: [],
  writtenAt: "2026-09-06T10:00:00Z",
  observationIds: ["a:1"],
  resolverVersion: "1.0.0",
};

describe("GET /traffic/conditions/applied", () => {
  it("returns the applied set unchanged", async () => {
    const app = Fastify();
    registerApi(app, { getTrafficConditionsApplied: () => APPLIED });
    const res = await app.inject({ method: "GET", url: "/traffic/conditions/applied" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(APPLIED);
    await app.close();
  });

  it("requires authentication for application evidence", async () => {
    const app = Fastify();
    registerAuth(app, "s3cret");
    registerApi(app, { getTrafficConditionsApplied: () => APPLIED });
    const denied = await app.inject({ method: "GET", url: "/traffic/conditions/applied" });
    expect(denied.statusCode).toBe(401);
    const res = await app.inject({
      method: "GET",
      url: "/traffic/conditions/applied",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(APPLIED);
    await app.close();
  });

  it("does not cache actuation receipts beyond their lease", async () => {
    const app = Fastify();
    registerApi(app, { getTrafficConditionsApplied: () => APPLIED });
    const res = await app.inject({ method: "GET", url: "/traffic/conditions/applied" });
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("answers 501 when live traffic is not configured", async () => {
    const app = Fastify();
    registerApi(app, {});
    const res = await app.inject({ method: "GET", url: "/traffic/conditions/applied" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "live traffic not configured" });
    await app.close();
  });

  it("still requires a bearer token on other traffic routes", async () => {
    const app = Fastify();
    registerAuth(app, "s3cret");
    registerApi(app, { getTrafficConditionsApplied: () => APPLIED });
    const res = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
