import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { parseBbox, setup } from "../index.js";

type Handler = (
  req: { query: Record<string, string | undefined> },
  reply: {
    status: (code: number) => { send: (body: unknown) => void };
    header: (k: string, v: string) => void;
    send: (body: unknown) => void;
  },
) => Promise<void>;

/**
 * Drives the `/events` route with a stub host: records the cache key each call
 * derives and the query options the aggregation would run under.
 */
function eventsHarness() {
  const cacheKeys: string[] = [];
  const routes = new Map<string, Handler>();
  const ctx = {
    registerRoute(_method: string, path: string, handler: Handler) {
      routes.set(path, handler);
    },
    cache: {
      async withCache<T>(key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        cacheKeys.push(key);
        return fn();
      },
    },
    getIntegrationsByDomain: () => [],
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as IntegrationContext;

  setup(ctx);

  return {
    cacheKeys,
    async get(query: Record<string, string | undefined>) {
      let status = 200;
      let body: unknown;
      await routes.get("/events")!(
        { query },
        {
          status: (code) => {
            status = code;
            return { send: (b: unknown) => (body = b) };
          },
          header: () => {},
          send: (b: unknown) => (body = b),
        },
      );
      return { status, body };
    },
  };
}

describe("parseBbox", () => {
  it("parses a valid bbox", () => {
    expect(parseBbox("-1,51,1,52")).toEqual([-1, 51, 1, 52]);
  });

  it("returns null for missing input", () => {
    expect(parseBbox(undefined)).toBeNull();
  });

  it("rejects a blank segment instead of silently substituting 0", () => {
    expect(parseBbox("1,,3,4")).toBeNull();
  });

  it("rejects non-finite segments", () => {
    expect(parseBbox("1,NaN,3,4")).toBeNull();
    expect(parseBbox("1,2,3")).toBeNull();
  });

  it("rejects out-of-range longitude", () => {
    expect(parseBbox("-181,51,1,52")).toBeNull();
    expect(parseBbox("-1,51,181,52")).toBeNull();
  });

  it("rejects out-of-range latitude", () => {
    expect(parseBbox("-1,-91,1,52")).toBeNull();
    expect(parseBbox("-1,51,1,91")).toBeNull();
  });

  it("rejects an inverted box where south > north", () => {
    expect(parseBbox("-1,52,1,51")).toBeNull();
  });

  it("rejects an inverted box where west > east (antimeridian boxes unsupported)", () => {
    expect(parseBbox("170,10,-170,20")).toBeNull();
  });
});

describe("GET /events horizonDays", () => {
  const BBOX = "13.39,52.49,13.41,52.51";

  it("gives each horizon its own cache key", async () => {
    const h = eventsHarness();
    await h.get({ bbox: BBOX });
    await h.get({ bbox: BBOX, horizonDays: "0" });
    await h.get({ bbox: BBOX, horizonDays: "7" });
    expect(new Set(h.cacheKeys).size).toBe(3);
    expect(h.cacheKeys[1]).toMatch(/:0$/);
    expect(h.cacheKeys[2]).toMatch(/:7$/);
  });

  it("treats a non-integer or negative horizon as absent, not as 0", async () => {
    const h = eventsHarness();
    await h.get({ bbox: BBOX });
    const noParam = h.cacheKeys[0];
    await h.get({ bbox: BBOX, horizonDays: "abc" });
    await h.get({ bbox: BBOX, horizonDays: "-1" });
    await h.get({ bbox: BBOX, horizonDays: "1.5" });
    expect(h.cacheKeys).toEqual([noParam, noParam, noParam, noParam]);
  });

  it("still rejects a malformed bbox", async () => {
    const h = eventsHarness();
    const res = await h.get({ bbox: "1,,3,4", horizonDays: "0" });
    expect(res.status).toBe(400);
  });
});
