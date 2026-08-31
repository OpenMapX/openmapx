import { describe, expect, it } from "vitest";
import {
  createIntegrationHostTestApp,
  getIntegrationHealthMocks,
} from "./support/integration-host-environment";

describe("integration host test environment", () => {
  it("creates an isolated Fastify application", async () => {
    const app = createIntegrationHostTestApp();

    expect((await app.inject("/")).statusCode).toBe(404);
    await app.close();
  });

  it("starts health checks with an empty snapshot", async () => {
    const integrationHealthMocks = getIntegrationHealthMocks();
    await expect(integrationHealthMocks.executeAllIntegrationHealthChecks()).resolves.toEqual([]);
    expect(integrationHealthMocks.getCachedIntegrationHealthSnapshot()).toEqual({
      updatedAt: null,
      results: [],
    });
  });
});
