import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStreetLevelNodeCache,
  fetchStreetLevelNode,
  integrationIdFor,
} from "./useStreetLevelNode";

const REF = { providerId: "panoramax", imageId: "abc" };
const IMAGE = {
  id: "abc",
  providerId: "panoramax",
  lngLat: [2.352, 48.8573],
  isPano: true,
  fovDeg: 360,
  assets: { hd: "https://example.test/hd.jpg" },
};

function stubFetch(onImage: () => unknown = () => IMAGE) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      calls.push(url);
      const isLinks = url.endsWith("/links");
      return {
        ok: true,
        json: async () =>
          isLinks
            ? [
                {
                  id: "north",
                  providerId: "panoramax",
                  lngLat: [2.352, 48.8578],
                  rel: "next",
                },
              ]
            : onImage(),
      };
    }),
  );
  return calls;
}

beforeEach(() => {
  clearStreetLevelNodeCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integrationIdFor", () => {
  it("maps a provider id to its integration id", () => {
    expect(integrationIdFor("panoramax")).toBe("street-level-imagery-panoramax");
    expect(integrationIdFor("mapillary")).toBe("street-level-imagery-mapillary");
  });
});

describe("fetchStreetLevelNode", () => {
  it("combines the image and its selected arrows", async () => {
    stubFetch();
    const node = await fetchStreetLevelNode("http://api.test", REF);

    expect(node.id).toBe("panoramax:abc");
    expect(node.image.id).toBe("abc");
    expect(node.arrows).toHaveLength(1);
    expect(node.arrows[0]?.sector).toBe("N");
  });

  it("shares one request between concurrent callers", async () => {
    const calls = stubFetch();
    const [a, b] = await Promise.all([
      fetchStreetLevelNode("http://api.test", REF),
      fetchStreetLevelNode("http://api.test", REF),
    ]);

    expect(a).toBe(b);
    // Two URLs per load (image + links), so one shared load means two calls.
    expect(calls).toHaveLength(2);
  });

  it("keys the cache per provider", async () => {
    const calls = stubFetch();
    await fetchStreetLevelNode("http://api.test", REF);
    await fetchStreetLevelNode("http://api.test", { providerId: "mapillary", imageId: "abc" });
    expect(calls).toHaveLength(4);
  });

  it("refetches once the entry has aged out", async () => {
    const calls = stubFetch();
    await fetchStreetLevelNode("http://api.test", REF);
    expect(calls).toHaveLength(2);

    // Providers can hand out expiring signed asset URLs, so a resolved node
    // must not be served indefinitely.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      await fetchStreetLevelNode("http://api.test", REF);
    } finally {
      Date.now = realNow;
    }
    expect(calls).toHaveLength(4);
  });

  it("does not cache a failure", async () => {
    const calls: string[] = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        calls.push(url);
        attempt += 1;
        // Fail the first image request, succeed afterwards.
        const isLinks = url.endsWith("/links");
        if (!isLinks && attempt <= 2) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => (isLinks ? [] : IMAGE) };
      }),
    );

    let threw = false;
    try {
      await fetchStreetLevelNode("http://api.test", REF);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const node = await fetchStreetLevelNode("http://api.test", REF);
    expect(node.image.id).toBe("abc");
  });
});
