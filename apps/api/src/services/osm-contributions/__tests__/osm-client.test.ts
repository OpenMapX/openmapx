import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOsmConfig } from "../../../utils/osm-config.js";
import { createOsmApiClient } from "../osm-client.js";
import { isOsmUpstreamError, type OsmUpstreamError, type OsmWritableElement } from "../types.js";

const TOKEN = "osm-write-token-sentinel";
const config = loadOsmConfig({
  OSM_API_URL: "https://master.apis.dev.openstreetmap.org",
  OSM_WEB_URL: "https://master.apis.dev.openstreetmap.org",
  OSM_DISCOVERY_URL: "https://master.apis.dev.openstreetmap.org/.well-known/openid-configuration",
});

let fetchMock: ReturnType<typeof vi.fn>;

function client() {
  return createOsmApiClient({ config, fetchImpl: fetchMock as unknown as typeof fetch });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function text(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { "content-type": "text/plain", ...init.headers },
  });
}

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  return { url: call?.[0] as string, init: (call?.[1] ?? {}) as RequestInit };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

const NODE_BODY = {
  version: "0.6",
  elements: [
    {
      type: "node",
      id: 12,
      version: 4,
      lat: 52.5,
      lon: 13.4,
      changeset: 900,
      visible: true,
      tags: { amenity: "cafe", name: "Café" },
    },
  ],
};

beforeEach(() => {
  fetchMock = vi.fn();
});

describe("request shaping", () => {
  it("reads an element from the configured API base without a token", async () => {
    fetchMock.mockResolvedValue(json(NODE_BODY));
    await client().getElement({ type: "node", id: 12 });
    const { url, init } = lastRequest();
    expect(url).toBe("https://master.apis.dev.openstreetmap.org/api/0.6/node/12.json");
    expect(init.method ?? "GET").toBe("GET");
    expect(headerOf(init, "authorization")).toBeUndefined();
    expect(headerOf(init, "accept")).toBe("application/json");
    expect(headerOf(init, "user-agent")).toMatch(/^OpenMapX\/1\.0 \(/);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the bearer token only for permissions, user details and mutations", async () => {
    fetchMock.mockResolvedValue(json({ permissions: ["allow_write_api"] }));
    await client().getPermissions(TOKEN);
    expect(headerOf(lastRequest().init, "authorization")).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockResolvedValue(
      json({
        user: {
          id: 5,
          display_name: "mapper",
          contributor_terms: { agreed: true },
          blocks: { received: { active: 0 } },
        },
      }),
    );
    await client().getUserDetails(TOKEN);
    expect(headerOf(lastRequest().init, "authorization")).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockResolvedValue(json({ elements: [{ type: "changeset", id: 3, open: true }] }));
    await client().getChangeset(3);
    expect(headerOf(lastRequest().init, "authorization")).toBeUndefined();
  });

  it("never puts a token, comment or note text in a URL", async () => {
    fetchMock.mockResolvedValue(text("77"));
    await client().createChangeset({ comment: "human comment sentinel" }, TOKEN);
    const { url, init } = lastRequest();
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("comment");
    expect(url).toBe("https://master.apis.dev.openstreetmap.org/api/0.6/changeset/create");
    expect(init.method).toBe("PUT");
    expect(headerOf(init, "content-type")).toBe("text/xml; charset=utf-8");
    expect(headerOf(init, "accept")).toBe("text/plain");
    expect(String(init.body)).toContain("human comment sentinel");
  });

  it("PUTs a complete element as XML and returns the new version", async () => {
    fetchMock.mockResolvedValue(text("5"));
    const element: OsmWritableElement = {
      type: "way",
      id: 42,
      version: 4,
      changeset: 77,
      nodes: [1, 2, 3],
      tags: { building: "yes" },
    };
    await expect(client().updateElement(element, TOKEN)).resolves.toBe(5);
    const { url, init } = lastRequest();
    expect(url).toBe("https://master.apis.dev.openstreetmap.org/api/0.6/way/42");
    expect(init.method).toBe("PUT");
    expect(headerOf(init, "content-type")).toBe("text/xml; charset=utf-8");
    expect(String(init.body)).toContain('<nd ref="1"/>');
  });

  it("closes a changeset with an empty PUT", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await client().closeChangeset(77, TOKEN);
    const { url, init } = lastRequest();
    expect(url).toBe("https://master.apis.dev.openstreetmap.org/api/0.6/changeset/77/close");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
  });

  it("creates a note with a JSON body, never a query string", async () => {
    fetchMock.mockResolvedValue(json({ properties: { id: 9, status: "open" } }));
    await expect(
      client().createNote({ lat: 52.5, lon: 13.4, text: "note text sentinel" }, TOKEN),
    ).resolves.toEqual({ id: 9, status: "open" });
    const { url, init } = lastRequest();
    expect(url).toBe("https://master.apis.dev.openstreetmap.org/api/0.6/notes.json");
    expect(url).not.toContain("note text");
    expect(init.method).toBe("POST");
    expect(headerOf(init, "content-type")).toBe("application/json");
    expect(headerOf(init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({
      lat: 52.5,
      lon: 13.4,
      text: "note text sentinel",
    });
  });
});

describe("element parsing", () => {
  it("returns a discriminated node with its tags", async () => {
    fetchMock.mockResolvedValue(json(NODE_BODY));
    await expect(client().getElement({ type: "node", id: 12 })).resolves.toEqual({
      type: "node",
      id: 12,
      version: 4,
      lat: 52.5,
      lon: 13.4,
      changeset: 900,
      visible: true,
      tags: { amenity: "cafe", name: "Café" },
    });
  });

  it("preserves ordered way nodes and relation members", async () => {
    fetchMock.mockResolvedValue(
      json({ elements: [{ type: "way", id: 42, version: 1, nodes: [3, 1, 2, 3] }] }),
    );
    const way = await client().getElement({ type: "way", id: 42 });
    expect(way).toMatchObject({ type: "way", nodes: [3, 1, 2, 3], tags: {} });

    fetchMock.mockResolvedValue(
      json({
        elements: [
          {
            type: "relation",
            id: 7,
            version: 2,
            members: [
              { type: "way", ref: 1, role: "outer" },
              { type: "node", ref: 2, role: "" },
            ],
          },
        ],
      }),
    );
    const relation = await client().getElement({ type: "relation", id: 7 });
    expect(relation).toMatchObject({
      type: "relation",
      members: [
        { type: "way", ref: 1, role: "outer" },
        { type: "node", ref: 2, role: "" },
      ],
    });
  });

  it("rejects a response whose primary element does not match the request", async () => {
    fetchMock.mockResolvedValue(json({ elements: [{ ...NODE_BODY.elements[0], id: 13 }] }));
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toSatisfy(
      (error: unknown) => isOsmUpstreamError(error),
    );
  });

  it("rejects zero elements and malformed JSON", async () => {
    fetchMock.mockResolvedValue(json({ elements: [] }));
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toThrow();

    fetchMock.mockResolvedValue(
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toThrow();
  });

  it("rejects out-of-range coordinates and unsafe ids", async () => {
    fetchMock.mockResolvedValue(
      json({ elements: [{ type: "node", id: 12, version: 1, lat: 999, lon: 13.4 }] }),
    );
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toThrow();
  });

  it("rejects an element beyond the defensive tag bound", async () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 5_001; i += 1) tags[`k${i}`] = "v";
    fetchMock.mockResolvedValue(
      json({ elements: [{ type: "node", id: 12, version: 1, lat: 1, lon: 1, tags }] }),
    );
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toThrow();
  });
});

describe("full reads and centres", () => {
  it("returns referenced node coordinates for a way", async () => {
    fetchMock.mockResolvedValue(
      json({
        elements: [
          { type: "node", id: 1, version: 1, lat: 52.0, lon: 13.0 },
          { type: "node", id: 2, version: 1, lat: 52.2, lon: 13.4 },
          { type: "way", id: 42, version: 1, nodes: [1, 2] },
        ],
      }),
    );
    const full = await client().getFullElement({ type: "way", id: 42 });
    expect(lastRequest().url).toBe(
      "https://master.apis.dev.openstreetmap.org/api/0.6/way/42/full.json",
    );
    expect(full.primary).toMatchObject({ type: "way", id: 42 });
    expect(full.nodes).toEqual([
      { id: 1, lat: 52.0, lon: 13.0 },
      { id: 2, lat: 52.2, lon: 13.4 },
    ]);
  });

  it("collects member node coordinates for a relation", async () => {
    fetchMock.mockResolvedValue(
      json({
        elements: [
          { type: "node", id: 5, version: 1, lat: 48.1, lon: 11.5 },
          { type: "relation", id: 7, version: 1, members: [{ type: "node", ref: 5, role: "" }] },
        ],
      }),
    );
    const full = await client().getFullElement({ type: "relation", id: 7 });
    expect(full.nodes).toEqual([{ id: 5, lat: 48.1, lon: 11.5 }]);
  });
});

describe("upstream failures", () => {
  const cases: Array<[number, boolean]> = [
    [401, false],
    [403, false],
    [404, false],
    [409, false],
    [410, false],
    [412, false],
    [429, false],
    [500, false],
  ];

  it.each(cases)("maps HTTP %i to a bounded upstream error", async (status) => {
    fetchMock.mockResolvedValue(
      new Response("upstream body with account detail", {
        status,
        headers: { "content-type": "text/plain" },
      }),
    );
    const error = (await client()
      .getElement({ type: "node", id: 12 })
      .catch((e: unknown) => e)) as OsmUpstreamError;
    expect(isOsmUpstreamError(error)).toBe(true);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain("account detail");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("account detail");
  });

  it("parses an integer and an HTTP-date Retry-After", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "12" } }),
    );
    let error = (await client()
      .getElement({ type: "node", id: 12 })
      .catch((e: unknown) => e)) as OsmUpstreamError;
    expect(error.retryAfterSeconds).toBe(12);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchMock.mockResolvedValue(
      new Response("", {
        status: 429,
        headers: { "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" },
      }),
    );
    error = (await client()
      .getElement({ type: "node", id: 12 })
      .catch((e: unknown) => e)) as OsmUpstreamError;
    expect(error.retryAfterSeconds).toBe(30);
    vi.useRealTimers();
  });

  it("treats a network failure on a read as not applied", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = (await client()
      .getElement({ type: "node", id: 12 })
      .catch((e: unknown) => e)) as OsmUpstreamError;
    expect(error.requestMayHaveBeenApplied).toBe(false);
  });

  it("treats a timeout after transmitting a mutation as possibly applied", async () => {
    fetchMock.mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    const element: OsmWritableElement = {
      type: "node",
      id: 12,
      version: 4,
      changeset: 7,
      lat: 1,
      lon: 1,
      tags: {},
    };
    const error = (await client()
      .updateElement(element, TOKEN)
      .catch((e: unknown) => e)) as OsmUpstreamError;
    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(error.operation).toBe("publish");
  });

  it("rejects a redirect rather than following it", async () => {
    fetchMock.mockRejectedValue(new TypeError("unexpected redirect"));
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toThrow();
    // `redirect: "error"` is what makes the rejection happen at all.
    fetchMock.mockResolvedValue(json(NODE_BODY));
    await client().getElement({ type: "node", id: 12 });
    expect(lastRequest().init.redirect).toBe("error");
  });
});

describe("bounded plain-text responses", () => {
  it("accepts a positive decimal integer id", async () => {
    fetchMock.mockResolvedValue(text("  123456  "));
    await expect(client().createChangeset({}, TOKEN)).resolves.toBe(123456);
  });

  it("rejects a non-numeric, negative, zero or oversize id", async () => {
    for (const body of ["abc", "-1", "0", "1.5", "1e3", "9".repeat(80), ""]) {
      fetchMock.mockResolvedValue(text(body));
      await expect(client().createChangeset({}, TOKEN)).rejects.toThrow();
    }
  });

  it("ignores a small close-response body", async () => {
    fetchMock.mockResolvedValue(text("ok"));
    await expect(client().closeChangeset(1, TOKEN)).resolves.toBeUndefined();
  });
});

describe("body size bounds", () => {
  it("rejects a JSON element body beyond 2 MiB", async () => {
    const huge = `{"elements":[{"type":"node","id":12,"version":1,"lat":1,"lon":1,"tags":{"a":"${"x".repeat(
      3 * 1024 * 1024,
    )}"}}]}`;
    fetchMock.mockResolvedValue(
      new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(client().getElement({ type: "node", id: 12 })).rejects.toThrow();
  });

  it("allows a larger /full body but still bounds it", async () => {
    const huge = `{"elements":[{"type":"way","id":42,"version":1,"nodes":[1],"tags":{"a":"${"x".repeat(
      6 * 1024 * 1024,
    )}"}}]}`;
    fetchMock.mockResolvedValue(
      new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(client().getFullElement({ type: "way", id: 42 })).rejects.toThrow();
  });
});

describe("permissions and user details", () => {
  it("maps the permission list explicitly", async () => {
    fetchMock.mockResolvedValue(json({ permissions: ["allow_read_prefs", "allow_write_notes"] }));
    await expect(client().getPermissions(TOKEN)).resolves.toEqual({
      allowWriteApi: false,
      allowWriteNotes: true,
    });
  });

  it("maps terms and active blocks", async () => {
    fetchMock.mockResolvedValue(
      json({
        user: {
          id: 5,
          display_name: "mapper",
          contributor_terms: { agreed: false },
          blocks: { received: { active: 2 } },
        },
      }),
    );
    await expect(client().getUserDetails(TOKEN)).resolves.toEqual({
      id: 5,
      displayName: "mapper",
      contributorTermsAgreed: false,
      activeBlock: true,
    });
  });

  it("rejects malformed user details rather than defaulting", async () => {
    fetchMock.mockResolvedValue(json({ user: { id: 0, display_name: "" } }));
    await expect(client().getUserDetails(TOKEN)).rejects.toThrow();
  });
});
