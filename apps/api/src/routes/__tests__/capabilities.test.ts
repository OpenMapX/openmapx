import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../integration-host.js", () => ({ getAllIntegrations: () => [] }));
vi.mock("../../services/integration-health.js", () => ({ isIntegrationHealthy: () => true }));

const { buildTestApp } = await import("../../test/app.js");
const { capabilitiesRoute } = await import("../capabilities.js");
const { resetOsmConfigForTests } = await import("../../utils/osm-config.js");

let app: FastifyInstance;

async function capabilities(env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetOsmConfigForTests();
  app = await buildTestApp(capabilitiesRoute, { prefix: "/api" });
  const response = await app.inject({ method: "GET", url: "/api/capabilities" });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetOsmConfigForTests();
  return response;
}

afterEach(async () => {
  await app?.close();
});

describe("GET /api/capabilities", () => {
  it("preserves the services map and its cache header", async () => {
    const response = await capabilities({});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("services");
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("reports the OSM contribution feature as off by default", async () => {
    const response = await capabilities({
      OSM_CONTRIBUTIONS_ENABLED: undefined,
      OSM_CLIENT_ID: undefined,
      OSM_CLIENT_SECRET: undefined,
    });
    expect(response.json().features).toEqual({ osmContributions: false });
  });

  it("stays off when the flag is on but OAuth is unconfigured", async () => {
    const response = await capabilities({
      OSM_CONTRIBUTIONS_ENABLED: "true",
      OSM_CLIENT_ID: undefined,
      OSM_CLIENT_SECRET: undefined,
    });
    expect(response.json().features.osmContributions).toBe(false);
  });

  it("turns on only with the master flag and both credentials", async () => {
    const response = await capabilities({
      OSM_CONTRIBUTIONS_ENABLED: "true",
      OSM_CLIENT_ID: "id",
      OSM_CLIENT_SECRET: "secret",
    });
    expect(response.json().features.osmContributions).toBe(true);
  });

  it("never exposes the direct-write kill switch or any account state", async () => {
    const response = await capabilities({
      OSM_CONTRIBUTIONS_ENABLED: "true",
      OSM_DIRECT_EDITING_ENABLED: "true",
      OSM_CLIENT_ID: "id",
      OSM_CLIENT_SECRET: "secret",
    });
    const body = response.json();
    expect(Object.keys(body.features)).toEqual(["osmContributions"]);
    expect(response.body).not.toContain("directEditing");
    expect(response.body).not.toContain("linked");
    expect(response.body).not.toContain("secret");
  });
});
