import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { statusRoute } from "../status.js";

describe("GET /api/status", () => {
  beforeEach(() => {
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
    expect(response.json().services).toContainEqual({
      id: "enabled",
      name: "Enabled integration",
      category: "External",
      url: "https://example.com/health",
      status: "up",
    });
    expect(mocks.getCachedIntegrationHealthSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ id: "enabled" }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
