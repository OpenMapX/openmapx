import { beforeEach, describe, expect, it, vi } from "vitest";

const overpassQuerySafe = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  overpassQuerySafe: (...args: unknown[]) => overpassQuerySafe(...args),
}));

import { createFencedMemoryCache } from "@openmapx/integration-framework/testing";
import kaarst from "../__fixtures__/kaarst-maubisstrasse-alerts.json";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

const BBOX = "51.226,6.612,51.233,6.626";

function environment() {
  const stored: { key: string; ttl: number; cached: boolean }[] = [];
  const cache = {
    get: vi.fn(async () => null),
    withCache: vi.fn(
      async (
        key: string,
        ttl: number,
        factory: () => Promise<unknown>,
        _callerSignal?: AbortSignal,
        shouldCache?: (value: unknown) => boolean,
      ) => {
        const value = await factory();
        stored.push({ key, ttl, cached: shouldCache ? shouldCache(value) : true });
        return value;
      },
    ),
    set: vi.fn(async (key: string, _value: unknown, ttl?: number) => {
      held.push({ key, ttl });
    }),
  };
  const held: { key: string; ttl?: number }[] = [];
  const env = createRoutingHandlerEnvironment({
    routingProviders: [],
    contextOverrides: { cache: cache as never },
  });
  return { handler: env.getHandler("/navigation/alerts"), stored, held };
}

beforeEach(() => {
  overpassQuerySafe.mockReset();
});

describe("GET /navigation/alerts", () => {
  it("answers hazards with their roads and caches a complete answer for a day", async () => {
    overpassQuerySafe.mockResolvedValue({ elements: kaarst.elements });
    const { handler, stored } = environment();
    const reply = createRoutingTestReply();
    await handler({ query: { bbox: BBOX } }, reply);

    const body = reply.body as { alerts: { id: string; roads: unknown[] }[] };
    expect(Object.keys(reply.body as object)).toEqual(["alerts"]);
    expect(body.alerts.map((alert) => alert.id)).toContain("stop:8557831413");
    expect(body.alerts.every((alert) => alert.roads.length > 0)).toBe(true);
    expect(overpassQuerySafe.mock.calls[0][0]).toContain('way(bn.alerts)["highway"]');
    expect(stored).toEqual([
      { key: expect.stringMatching(/^cache:nav:alerts:v2/), ttl: 86_400, cached: true },
    ]);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "public, max-age=86400");
  });

  it("queries the box on the 0.001° grid its cache key stands for", async () => {
    overpassQuerySafe.mockResolvedValue({ elements: [] });
    const { handler } = environment();
    await handler(
      { query: { bbox: "51.22612,6.61249,51.23288,6.62501" } },
      createRoutingTestReply(),
    );
    expect(overpassQuerySafe.mock.calls[0][0]).toContain(
      'node["highway"="stop"](51.226,6.612,51.233,6.626)',
    );
  });

  it.each([
    ["no answer", null],
    ["an answer cut short", { elements: kaarst.elements, remark: "runtime error: timeout" }],
  ])("answers empty and holds the miss for a minute only, for %s", async (_name, answer) => {
    overpassQuerySafe.mockResolvedValue(answer);
    const { handler, stored, held } = environment();
    const reply = createRoutingTestReply();
    await handler({ query: { bbox: BBOX } }, reply);

    expect(reply.body).toEqual({ alerts: [] });
    expect(stored.map((entry) => entry.cached)).toEqual([false]);
    expect(held).toEqual([{ key: expect.stringMatching(/^cache:nav:alerts-hold:v1/), ttl: 60 }]);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("does not ask Overpass again while a miss is held, and asks once the hold ends", async () => {
    overpassQuerySafe.mockResolvedValue(null);
    const cache = createFencedMemoryCache();
    const handler = createRoutingHandlerEnvironment({
      routingProviders: [],
      contextOverrides: { cache },
    }).getHandler("/navigation/alerts");
    const ask = async () => {
      const reply = createRoutingTestReply();
      await handler({ query: { bbox: BBOX } }, reply);
      return reply;
    };

    await ask();
    const held = await ask();

    expect(overpassQuerySafe).toHaveBeenCalledTimes(1);
    expect(held.body).toEqual({ alerts: [] });
    expect(held.header).toHaveBeenCalledWith("Cache-Control", "no-store");

    for (const [key] of cache.values)
      if (key.startsWith("cache:nav:alerts-hold")) cache.values.delete(key);
    overpassQuerySafe.mockResolvedValue({ elements: kaarst.elements });
    const answered = await ask();

    expect(overpassQuerySafe).toHaveBeenCalledTimes(2);
    expect((answered.body as { alerts: unknown[] }).alerts.length).toBeGreaterThan(0);
  });
});
