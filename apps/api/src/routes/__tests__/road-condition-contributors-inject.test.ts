import { setup } from "@integrations/road-conditions";
import { situation } from "@integrations/road-conditions/__tests__/fixtures";
import { roadConditionAttributions } from "@integrations/road-conditions/attributions";
import { roadConditionFeatureToEvent } from "@openmapx/core";
import type { IntegrationContext, LoadedIntegration } from "@openmapx/integration-framework";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error("Unexpected authenticated call")),
}));
const receipt = {
  sourceId: "parent",
  name: "Publisher",
  url: "https://old.test",
  attributionText: "Old required notice",
  publisher: { name: "Original publisher" },
};
it("retains full and empty receipts through the actual events HTTP serializer and core reader", async () => {
  const credits = [receipt, { ...receipt, attributionText: "Second required notice" }];
  const events = [
    situation({ id: "a", contributors: credits }),
    situation({ id: "b", contributors: [], geometry: { type: "Point", coordinates: [5.2, 52.2] } }),
  ];
  const app = Fastify();
  const cached = new Map<string, string>();
  let acquisitions = 0;
  setup({
    registerRoute: (
      method: string,
      path: string,
      handler: Parameters<typeof registerIntegrationRoute>[3],
      options: Parameters<typeof registerIntegrationRoute>[4],
    ) => registerIntegrationRoute("road-conditions", method, path, handler, options),
    cache: {
      withCache: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
        if (!cached.has(key)) cached.set(key, JSON.stringify(await fn()));
        return JSON.parse(cached.get(key)!);
      },
    },
    getIntegrationsByDomain: () => [
      {
        id: "provider",
        providers: new Map([
          [
            "road-conditions",
            [
              {
                id: "provider",
                getEvents: async () => {
                  acquisitions++;
                  return events;
                },
              },
            ],
          ],
        ]),
      },
    ],
    log: { warn() {}, error() {} },
  } as unknown as IntegrationContext);
  registerIntegrationRouteDispatcher(
    app,
    new Map([["road-conditions", { id: "road-conditions", enabled: true } as LoadedIntegration]]),
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/integrations/road-conditions/events?bbox=4,51,6,53",
    });
    expect(response.statusCode).toBe(200);
    const parsed = response.json().features.map(roadConditionFeatureToEvent);
    expect(parsed.map((e: (typeof events)[number]) => e.contributors)).toEqual([credits, []]);
    expect(roadConditionAttributions(parsed)).toEqual(credits);
    const expected = structuredClone(credits);
    events[0]!.contributors = [{ sourceId: "new", name: "Changed provider configuration" }];
    const retained = await app.inject({
      method: "GET",
      url: "/api/integrations/road-conditions/events?bbox=4,51,6,53",
    });
    expect(retained.statusCode).toBe(200);
    expect(retained.json().features[0].properties.contributors).toEqual(expected);
    expect(acquisitions).toBe(1);
    expect([...cached.keys()][0]).toContain("situations-contributors-v3:");
  } finally {
    await app.close();
    resetIntegrationRoutes();
  }
});
