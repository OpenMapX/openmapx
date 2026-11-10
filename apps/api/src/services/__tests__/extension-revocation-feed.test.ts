import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  process.env.EXTENSION_CATALOG_URL = "https://catalog.example.test/catalog.json";
  process.env.EXTENSION_REVOCATION_URL = "https://catalog.example.test/revocations.json";
  return { values: new Map<string, string>() };
});

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({
  redis: {
    get: async (key: string) => store.values.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => {
      store.values.set(key, value);
      return "OK";
    },
  },
}));
vi.mock("../extension-store-cache", () => ({
  readExtensionSnapshot: async () => null,
  publishExtensionCatalog: async () => undefined,
  editExtensionSources: async () => undefined,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("@openmapx/core/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core/server")>();
  return {
    ...actual,
    safeFetchJson: <T>(url: string, options = {}) =>
      actual.safeFetchJson<T>(url, { ...options, fetchImplementation: globalThis.fetch }),
    safeFetchText: (url: string, options = {}) =>
      actual.safeFetchText(url, { ...options, fetchImplementation: globalThis.fetch }),
  };
});

import { getKillSwitch } from "../extension-store.js";

function jsonResponse(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: "",
    headers: new Headers({ "content-type": "application/json" }),
    body: new Response(body).body,
  } as unknown as Response;
}

function serveFeed(feed: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/revocations.json")) return feed();
      if (url.endsWith("/catalog.json")) return jsonResponse(200, "[]");
      throw new Error(`unexpected request to ${url}`);
    }),
  );
}

beforeEach(() => {
  store.values.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("revocation feed", () => {
  it("denies the entries a fresh feed lists and reports the data as current", async () => {
    serveFeed(() =>
      jsonResponse(
        200,
        JSON.stringify({
          removed: [{ id: "gone-ext", reason: "abandoned" }],
          critical: [{ id: "bad-ext", reason: "credential theft", maxVersion: "1.2.0" }],
        }),
      ),
    );

    const kill = await getKillSwitch();

    expect(kill.stale).toBe(false);
    expect(kill.removed.get("gone-ext")).toBe("abandoned");
    expect(kill.critical.get("bad-ext")).toEqual({
      reason: "credential theft",
      maxVersion: "1.2.0",
    });
  });

  it("treats an empty list as current rather than stale", async () => {
    serveFeed(() => jsonResponse(200, JSON.stringify({ removed: [], critical: [] })));

    const kill = await getKillSwitch();

    expect(kill.stale).toBe(false);
    expect(kill.removed.size).toBe(0);
    expect(kill.critical.size).toBe(0);
  });

  it("reports a missing feed as stale with nothing revoked when no snapshot exists", async () => {
    serveFeed(() => jsonResponse(404, "404: Not Found"));

    const kill = await getKillSwitch();

    expect(kill.stale).toBe(true);
    expect(kill.removed.size).toBe(0);
    expect(kill.critical.size).toBe(0);
  });

  it("keeps denying from the last good snapshot when the feed later disappears", async () => {
    serveFeed(() =>
      jsonResponse(200, JSON.stringify({ critical: [{ id: "bad-ext", reason: "advisory" }] })),
    );
    await getKillSwitch();

    serveFeed(() => jsonResponse(404, "404: Not Found"));
    const kill = await getKillSwitch();

    expect(kill.stale).toBe(true);
    expect(kill.critical.get("bad-ext")?.reason).toBe("advisory");
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["a list instead of an object", "[]"],
    ["a null document", "null"],
    ["a denial list that is not a list", JSON.stringify({ removed: "bad-ext" })],
    ["an entry without an id", JSON.stringify({ removed: [{ reason: "no id" }] })],
    ["an entry whose id is not text", JSON.stringify({ critical: [{ id: 7 }] })],
    ["an entry whose reason is not text", JSON.stringify({ removed: [{ id: "a", reason: 1 }] })],
  ])("never reads %s as an empty feed", async (_name, body) => {
    serveFeed(() => jsonResponse(200, body));

    const kill = await getKillSwitch();

    expect(kill.stale).toBe(true);
  });

  it("keeps the last good snapshot when a later feed is malformed", async () => {
    serveFeed(() =>
      jsonResponse(200, JSON.stringify({ removed: [{ id: "gone-ext", reason: "abandoned" }] })),
    );
    await getKillSwitch();

    serveFeed(() => jsonResponse(200, JSON.stringify({ removed: [{ id: 7 }] })));
    const kill = await getKillSwitch();

    expect(kill.stale).toBe(true);
    expect(kill.removed.get("gone-ext")).toBe("abandoned");
  });

  it("recovers to current data once the feed is published", async () => {
    serveFeed(() => jsonResponse(404, "404: Not Found"));
    expect((await getKillSwitch()).stale).toBe(true);

    serveFeed(() => jsonResponse(200, JSON.stringify({ removed: [], critical: [] })));
    expect((await getKillSwitch()).stale).toBe(false);
  });
});
