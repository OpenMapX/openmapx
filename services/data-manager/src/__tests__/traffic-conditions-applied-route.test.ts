import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerApi } from "../api.js";
import { registerAuth } from "../auth.js";

const APPLIED = {
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

  it("serves the applied set without a bearer token", async () => {
    const app = Fastify();
    registerAuth(app, "s3cret");
    registerApi(app, { getTrafficConditionsApplied: () => APPLIED });
    const res = await app.inject({ method: "GET", url: "/traffic/conditions/applied" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(APPLIED);
    await app.close();
  });

  it("is cacheable for a short window", async () => {
    const app = Fastify();
    registerApi(app, { getTrafficConditionsApplied: () => APPLIED });
    const res = await app.inject({ method: "GET", url: "/traffic/conditions/applied" });
    expect(res.headers["cache-control"]).toMatch(/max-age=\d+/);
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
