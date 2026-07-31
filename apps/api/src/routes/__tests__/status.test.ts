import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryAdminSession } from "../../utils/require-admin.js";
import { mockAdminSession } from "./admin-test-helpers.js";

const fakeSession = mockAdminSession();

const mocks = vi.hoisted(() => ({
  getAllIntegrations: vi.fn(),
  getCachedIntegrationHealthSnapshot: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({ sql: mocks.sql }));
vi.mock("../../redis.js", () => ({ redis: null }));
vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: mocks.getAllIntegrations,
}));
vi.mock("../../services/integration-health.js", () => ({
  getCachedIntegrationHealthSnapshot: mocks.getCachedIntegrationHealthSnapshot,
}));
vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: vi.fn(),
  getAdminSession: vi.fn(),
  tryAdminSession: vi.fn(),
}));

import { statusRoute } from "../status.js";

describe("GET /api/status", () => {
  beforeEach(() => {
    vi.mocked(tryAdminSession).mockResolvedValue(null);
    mocks.sql.mockResolvedValue([]);
    mocks.getAllIntegrations.mockReturnValue([
      { id: "enabled", enabled: true, manifest: { healthCheck: { type: "http" } } },
      { id: "disabled", enabled: false, manifest: { healthCheck: { type: "http" } } },
    ]);
    mocks.getCachedIntegrationHealthSnapshot.mockReturnValue({
      updatedAt: Date.parse("2026-07-28T08:00:00.000Z"),
      results: [
        {
          id: "enabled",
          name: "Enabled integration",
          category: "External",
          url: "https://example.com/health",
          status: "up",
        },
        {
          id: "down",
          name: "Down integration",
          category: "External",
          url: "https://internal.example.com/health",
          status: "down",
          error: "connect failed for internal.example.com",
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Keep it logically awesome", { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("combines live platform checks with cached integration results", async () => {
    const app = Fastify();
    await app.register(statusRoute, { prefix: "/api" });

    const response = await app.inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    const entry = response
      .json()
      .services.find((service: { id: string }) => service.id === "enabled");
    expect(entry).toMatchObject({
      id: "enabled",
      name: "Enabled integration",
      status: "up",
    });
    expect(entry).not.toHaveProperty("url");
    expect(entry).not.toHaveProperty("error");
    expect(mocks.getCachedIntegrationHealthSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ id: "enabled" }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("omits operator detail for anonymous callers", async () => {
    const app = Fastify();
    await app.register(statusRoute, { prefix: "/api" });

    const response = await app.inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    for (const service of response.json().services) {
      expect(service).not.toHaveProperty("url");
      expect(service).not.toHaveProperty("error");
    }

    await app.close();
  });

  it("includes full detail for admins", async () => {
    vi.mocked(tryAdminSession).mockResolvedValue(fakeSession);
    const app = Fastify();
    await app.register(statusRoute, { prefix: "/api" });

    const response = await app.inject({ method: "GET", url: "/api/status" });
    const services = response.json().services;
    const enabled = services.find((service: { id: string }) => service.id === "enabled");
    const down = services.find((service: { id: string }) => service.id === "down");

    expect(response.statusCode).toBe(200);
    expect(enabled).toHaveProperty("url", "https://example.com/health");
    expect(down).toHaveProperty("error", "connect failed for internal.example.com");

    await app.close();
  });

  it("degrades to the public view when session lookup fails", async () => {
    vi.mocked(tryAdminSession).mockRejectedValue(new Error("db down"));
    const app = Fastify();
    await app.register(statusRoute, { prefix: "/api" });

    const response = await app.inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    for (const service of response.json().services) {
      expect(service).not.toHaveProperty("url");
    }

    await app.close();
  });
});
