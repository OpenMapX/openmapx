import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createGofsCatalog } from "./catalog.js";

const UPSTREAM = {
  systems: [
    {
      "Country Code": "CA",
      Name: "Taxi Montréal",
      Location: "Montréal, QC",
      "Access Information": "https://www.registretaximontreal.ca/",
      URL: "https://taximtl.example/api/gofs-lite",
      "Supported Versions": 1.0,
    },
    {
      "Country Code": "US",
      Name: "Pace On Demand",
      Location: "Arlington Heights, IL",
      "Access Information": null,
      URL: "forthcoming",
      "Supported Versions": 1.0,
    },
    {
      "Country Code": "US",
      Name: "Freebee Miami Beach",
      Location: "Miami Beach, FL",
      "Access Information": null,
      URL: "https://lean.example/gofs/11",
      "Supported Versions": 1.0,
    },
  ],
};

const UPSTREAM_URL = "https://raw.githubusercontent.com/MobilityData/GOFS/main/systems.json";

function catalogWith(
  config: Record<string, unknown> = {},
  probe: (url: string, headers?: Record<string, string>) => Promise<unknown> = async () => ({
    data: { en: { feeds: [] } },
  }),
) {
  const ctx = createMockIntegrationContext({ id: "ride-gofs", config });
  const fetchJson = vi.fn(async (url: string, headers?: Record<string, string>) => {
    if (url === UPSTREAM_URL) return UPSTREAM;
    return probe(url, headers);
  });
  return { ctx, fetchJson, catalog: createGofsCatalog(ctx, fetchJson) };
}

describe("resolveFeeds", () => {
  it("includes upstream entries whose discovery document parses", async () => {
    const { catalog } = catalogWith({}, async () => ({
      data: { en: { feeds: [{ name: "zones", url: "https://x/z" }] } },
    }));
    const feeds = await catalog.resolveFeeds();
    expect(feeds.map((f) => f.name)).toContain("Freebee Miami Beach");
    expect(feeds.find((f) => f.name === "Freebee Miami Beach")?.origin).toBe("upstream");
  });

  it("drops the placeholder 'forthcoming' URL", async () => {
    const { catalog } = catalogWith();
    const feeds = await catalog.resolveFeeds();
    expect(feeds.map((f) => f.name)).not.toContain("Pace On Demand");
  });

  it("marks a 401 feed credential-required rather than dropping it", async () => {
    const { catalog } = catalogWith({}, async (url) => {
      if (url.includes("taximtl")) throw Object.assign(new Error("401"), { status: 401 });
      return { data: { en: { feeds: [] } } };
    });
    const montreal = (await catalog.resolveFeeds()).find((f) => f.name === "Taxi Montréal");
    expect(montreal?.status).toBe("credential-required");
    expect(montreal?.accessInformation).toBe("https://www.registretaximontreal.ca/");
  });

  it("drops a feed that is simply dead", async () => {
    const { catalog } = catalogWith({}, async (url) => {
      if (url.includes("taximtl")) throw new Error("ENOTFOUND");
      return { data: { en: { feeds: [] } } };
    });
    const feeds = await catalog.resolveFeeds();
    expect(feeds.map((f) => f.name)).not.toContain("Taxi Montréal");
  });

  it("lets an operator-configured feed override an upstream entry with the same id", async () => {
    const { catalog } = catalogWith(
      {
        feeds: [
          { id: "freebee-miami-beach", name: "Our Freebee", url: "https://mine.example/gofs" },
        ],
      },
      async () => ({ data: { en: { feeds: [{ name: "zones", url: "https://x/z" }] } } }),
    );
    const feeds = await catalog.resolveFeeds();
    const matches = feeds.filter((f) => f.id === "freebee-miami-beach");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Our Freebee");
    expect(matches[0].origin).toBe("operator");
  });

  it("survives a cache outage, still resolving feeds from the live registry", async () => {
    // Redis being down must read as a cache miss, not as an empty catalog —
    // running this against a host with Redis down was how the bug surfaced.
    const ctx = createMockIntegrationContext({
      id: "ride-gofs",
      config: {},
      cache: {
        get: async () => {
          throw new Error("ECONNREFUSED");
        },
        set: async () => {
          throw new Error("ECONNREFUSED");
        },
        del: async () => {
          throw new Error("ECONNREFUSED");
        },
        withCache: async <T>(_k: string, _t: number, fn: () => Promise<T>) => fn(),
      },
    });
    const fetchJson = vi.fn(async (url: string) => {
      if (url === UPSTREAM_URL) return UPSTREAM;
      return { data: { en: { feeds: [{ name: "zones", url: "https://x/z" }] } } };
    });
    const feeds = await createGofsCatalog(ctx, fetchJson).resolveFeeds();
    expect(feeds.map((f) => f.id)).toContain("freebee-miami-beach");
  });

  it("survives an unreachable upstream registry, keeping operator feeds", async () => {
    const ctx = createMockIntegrationContext({
      id: "ride-gofs",
      config: { feeds: [{ id: "mine", name: "Mine", url: "https://mine.example/gofs" }] },
    });
    const fetchJson = vi.fn(async (url: string) => {
      if (url === UPSTREAM_URL) throw new Error("registry down");
      return { data: { en: { feeds: [{ name: "zones", url: "https://x/z" }] } } };
    });
    const feeds = await createGofsCatalog(ctx, fetchJson).resolveFeeds();
    expect(feeds.map((f) => f.id)).toEqual(["mine"]);
  });

  it("skips the upstream registry entirely when useUpstreamCatalog is false", async () => {
    const { catalog, fetchJson } = catalogWith({ useUpstreamCatalog: false });
    await catalog.resolveFeeds();
    expect(fetchJson.mock.calls.map(([u]) => u)).not.toContain(UPSTREAM_URL);
  });

  it("derives a stable slug id from the system name", async () => {
    const { catalog } = catalogWith({}, async () => ({
      data: { en: { feeds: [{ name: "zones", url: "https://x/z" }] } },
    }));
    const feeds = await catalog.resolveFeeds();
    expect(feeds.map((f) => f.id)).toContain("freebee-miami-beach");
  });
});

describe("credentials", () => {
  /** Only answers Montréal when the X-API-KEY header carries the right value. */
  const keyedProbe =
    (expected: string) => async (url: string, headers?: Record<string, string>) => {
      if (!url.includes("taximtl")) return { data: { en: { feeds: [] } } };
      if (headers?.["X-API-KEY"] !== expected) {
        throw Object.assign(new Error("401"), { status: 401 });
      }
      return { data: { en: { feeds: [{ name: "zones", url: "https://taximtl.example/zones" }] } } };
    };

  it("stays credential-required when no key is stored", async () => {
    const { catalog } = catalogWith({}, keyedProbe("secret"));
    const montreal = (await catalog.resolveFeeds()).find((f) => f.id === "taxi-montreal");
    expect(montreal?.status).toBe("credential-required");
    expect(montreal?.auth).toBeUndefined();
  });

  it("goes live once the named credential is stored", async () => {
    const { catalog } = catalogWith({ "ca-taxi-montreal-api-key": "secret" }, keyedProbe("secret"));
    const montreal = (await catalog.resolveFeeds()).find((f) => f.id === "taxi-montreal");
    expect(montreal?.status).toBe("live");
    expect(montreal?.auth).toEqual({ kind: "header", name: "X-API-KEY", value: "secret" });
  });

  it("stays credential-required when the stored key is rejected", async () => {
    const { catalog } = catalogWith({ "ca-taxi-montreal-api-key": "wrong" }, keyedProbe("secret"));
    const montreal = (await catalog.resolveFeeds()).find((f) => f.id === "taxi-montreal");
    expect(montreal?.status).toBe("credential-required");
  });

  it("ignores a blank credential", async () => {
    const { catalog } = catalogWith({ "ca-taxi-montreal-api-key": "   " }, keyedProbe("secret"));
    const montreal = (await catalog.resolveFeeds()).find((f) => f.id === "taxi-montreal");
    expect(montreal?.auth).toBeUndefined();
  });

  it("does not reuse the anonymous probe verdict after a key is stored", async () => {
    const store = new Map<string, unknown>();
    const ctx = createMockIntegrationContext({
      id: "ride-gofs",
      config: {},
      cache: {
        get: async (k: string) => (store.get(k) ?? null) as never,
        set: async (k: string, v: unknown) => void store.set(k, v),
        del: async (k: string) => void store.delete(k),
        withCache: async <T>(_k: string, _t: number, fn: () => Promise<T>) => fn(),
      },
    });

    const fetchJson = vi.fn(async (url: string, headers?: Record<string, string>) => {
      if (url === UPSTREAM_URL) return UPSTREAM;
      return keyedProbe("secret")(url, headers);
    });

    await createGofsCatalog(ctx, fetchJson).resolveFeeds();
    expect(store.has("gofs:probe:taxi-montreal:anon")).toBe(true);

    ctx.config["ca-taxi-montreal-api-key"] = "secret";
    const montreal = (await createGofsCatalog(ctx, fetchJson).resolveFeeds()).find(
      (f) => f.id === "taxi-montreal",
    );
    expect(montreal?.status).toBe("live");
  });

  it("binds an operator feed to a generic credential slot", async () => {
    const { catalog } = catalogWith(
      {
        "gofs-custom-1-api-key": "mine",
        feeds: [
          {
            id: "private",
            name: "Private",
            url: "https://private.example/gofs",
            credentialSlot: 1,
            authKind: "query",
            authParam: "api_key",
          },
        ],
      },
      async (url) => {
        if (!url.includes("private.example")) return { data: { en: { feeds: [] } } };
        if (!url.includes("api_key=mine")) throw Object.assign(new Error("403"), { status: 403 });
        return { data: { en: { feeds: [{ name: "zones", url: "https://private.example/z" }] } } };
      },
    );
    const feed = (await catalog.resolveFeeds()).find((f) => f.id === "private");
    expect(feed?.status).toBe("live");
    expect(feed?.auth).toEqual({ kind: "query", name: "api_key", value: "mine" });
  });

  it("ignores a slot binding with no stored key", async () => {
    const { catalog } = catalogWith({
      feeds: [
        { id: "private", name: "Private", url: "https://private.example/gofs", credentialSlot: 2 },
      ],
    });
    const feed = (await catalog.resolveFeeds()).find((f) => f.id === "private");
    expect(feed?.auth).toBeUndefined();
  });

  it("ignores an out-of-range slot number", async () => {
    const { catalog } = catalogWith({
      "gofs-custom-1-api-key": "mine",
      feeds: [
        { id: "private", name: "Private", url: "https://private.example/gofs", credentialSlot: 9 },
      ],
    });
    const feed = (await catalog.resolveFeeds()).find((f) => f.id === "private");
    expect(feed?.auth).toBeUndefined();
  });
});
