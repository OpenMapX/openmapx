import type { LoadedIntegration } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginIntegrationRouteStaging,
  commitIntegrationRouteStaging,
  dropIntegrationRoutes,
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes.js";

let app: FastifyInstance;

function register(integrationId: string, generation: string) {
  registerIntegrationRoute(integrationId, "GET", "/generation", (_req, reply) =>
    reply.send({ generation }),
  );
}

async function answer(integrationId: string) {
  const response = await app.inject(`/api/integrations/${integrationId}/generation`);
  return response.statusCode === 200 ? response.json().generation : response.statusCode;
}

beforeEach(async () => {
  resetIntegrationRoutes();
  app = Fastify({ logger: false });
  const enabled = { enabled: true } as unknown as LoadedIntegration;
  registerIntegrationRouteDispatcher(
    app,
    new Map([
      ["kept", enabled],
      ["dropped", enabled],
    ]),
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
  resetIntegrationRoutes();
});

describe("dropping one integration's routes", () => {
  it("removes only that integration's routes from the live table", async () => {
    register("kept", "live");
    register("dropped", "live");

    dropIntegrationRoutes("dropped");

    expect(await answer("dropped")).toBe(404);
    expect(await answer("kept")).toBe("live");
  });

  it("acts on the staged table while staging is active and leaves the live one alone", async () => {
    register("kept", "live");
    register("dropped", "live");
    beginIntegrationRouteStaging();
    register("kept", "staged");
    register("dropped", "staged");

    dropIntegrationRoutes("dropped");

    expect(await answer("dropped")).toBe("live");
    expect(await answer("kept")).toBe("live");
    commitIntegrationRouteStaging();
    expect(await answer("dropped")).toBe(404);
    expect(await answer("kept")).toBe("staged");
  });
});
