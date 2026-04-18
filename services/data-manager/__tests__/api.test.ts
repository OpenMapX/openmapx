import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerApi } from "../src/api.js";

describe("data-manager API", () => {
  it("GET /datasets returns empty list when no state", async () => {
    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-test-empty" });
    const res = await app.inject({ method: "GET", url: "/datasets" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ datasets: [] });
    await app.close();
  });

  it("GET /status returns service status", async () => {
    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-test-status" });
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});
