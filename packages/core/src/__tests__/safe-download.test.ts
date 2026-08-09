import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});

// Import AFTER vi.mock so the mocked lookup is captured. We re-import the
// mocked module to drive the mock.
import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import {
  assertResolvesToPublicIp,
  SafeFetchHttpError,
  safeFetchJson,
  safeFetchJsonResponse,
} from "../utils/safe-download";

// dnsLookup has overloads that confuse vi.mocked; cast to a simple mock.
const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;
const undiciFetchMock = undiciFetch as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  lookupMock.mockReset();
  undiciFetchMock.mockReset();
});

describe("assertResolvesToPublicIp", () => {
  it("passes for a public IPv4", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertResolvesToPublicIp("example.com")).resolves.toBeUndefined();
  });

  it("rejects when DNS returns loopback IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects when DNS returns a private RFC1918 IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects link-local IPv6", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "fe80::1", family: 6 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects IPv4-mapped IPv6 loopback", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects when ANY returned record is private (dual-stack rebinding guard)", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(assertResolvesToPublicIp("sneaky.test")).rejects.toThrow(/private IP/);
  });

  it("rejects when DNS returns no records", async () => {
    lookupMock.mockResolvedValueOnce([]);
    await expect(assertResolvesToPublicIp("unknown.test")).rejects.toThrow(/No DNS records/);
  });
});

function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  bodyText?: string;
  url?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: opts.url ?? "",
    headers: new Headers(opts.headers ?? {}),
    body: new Response(opts.bodyText ?? "").body,
  } as unknown as Response;
}

function stubFetchSequence(...responses: Response[]): ReturnType<typeof vi.fn> {
  for (const response of responses) undiciFetchMock.mockResolvedValueOnce(response);
  return undiciFetchMock;
}

describe("safeFetchJson", () => {
  it("resolves parsed JSON on the happy path", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ version: "1.2.3" }),
      }),
    );
    await expect(safeFetchJson("https://ex.test/x.json")).resolves.toEqual({ version: "1.2.3" });
  });

  it("exposes successful status, headers, and final URL without changing parsed data", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 201,
        url: "https://ex.test/final.json",
        headers: { "content-type": "application/json; charset=utf-8", "x-request-id": "test-id" },
        bodyText: JSON.stringify({ ok: true }),
      }),
    );

    const response = await safeFetchJsonResponse("https://ex.test/initial.json");
    expect(response).toMatchObject({
      data: { ok: true },
      status: 201,
      finalUrl: "https://ex.test/final.json",
    });
    expect(response.headers.get("x-request-id")).toBe("test-id");
  });

  it("accepts configured GeoJSON media types after stripping parameters", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        headers: { "content-type": "application/geo+json; charset=utf-8" },
        bodyText: JSON.stringify({ type: "FeatureCollection", features: [] }),
      }),
    );

    await expect(
      safeFetchJsonResponse("https://ex.test/tracks", {
        acceptedContentTypes: ["application/json", "application/geo+json"],
      }),
    ).resolves.toMatchObject({ data: { type: "FeatureCollection" } });
  });

  it("rejects an unexpected HTML content type before buffering it", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({ headers: { "content-type": "text/html" }, bodyText: "<html></html>" }),
    );

    await expect(
      safeFetchJsonResponse("https://ex.test/error", {
        acceptedContentTypes: ["application/json"],
      }),
    ).rejects.toThrow(/content type/i);
  });

  it("reports a 401 without retaining the upstream response body", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({ status: 401, bodyText: "upstream diagnostic that must not leak" }),
    );

    let caught: Error | undefined;
    try {
      await safeFetchJsonResponse("https://ex.test/me");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toMatchObject({
      name: "SafeFetchHttpError",
      status: 401,
      retryAfterSeconds: null,
      finalUrl: "https://ex.test/me",
    });
    expect(caught?.message).not.toMatch(/upstream diagnostic/i);
  });

  it("reports a 429 retry delay as a typed safe HTTP error", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ status: 429, headers: { "retry-after": "17" } }));

    try {
      await safeFetchJsonResponse("https://ex.test/rate-limited");
      throw new Error("expected request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SafeFetchHttpError);
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 17 });
    }
  });

  it.each(["9000000000000000", "9007199254740992"])(
    "drops unsafe or overly long Retry-After value %s",
    async (retryAfter) => {
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      stubFetchSequence(makeResponse({ status: 429, headers: { "retry-after": retryAfter } }));

      try {
        await safeFetchJsonResponse("https://ex.test/rate-limited");
        throw new Error("expected request to reject");
      } catch (error) {
        expect(error).toMatchObject({ status: 429, retryAfterSeconds: null });
      }
    },
  );

  it("rejects a private-resolving host before any network request", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = stubFetchSequence();
    await expect(safeFetchJson("https://sneaky.test/x.json")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks DNS rebinding when the connection-time lookup turns private", async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = stubFetchSequence(
      makeResponse({
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ ok: true }),
      }),
    );

    await expect(safeFetchJson("https://rebind.test/feed.json")).rejects.toThrow(/not allowed/i);
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks every redirect host immediately before its pinned connection", async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = stubFetchSequence(
      makeResponse({
        status: 302,
        headers: { location: "https://rebound-redirect.test/feed.json" },
      }),
      makeResponse({
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ ok: true }),
      }),
    );

    await expect(safeFetchJson("https://ex.test/feed.json")).rejects.toThrow(/not allowed/i);
    expect(lookupMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never echoes the resolved IP in the rejection message", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    stubFetchSequence();
    let caught: Error | undefined;
    try {
      await safeFetchJson("https://sneaky.test/x.json");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/not allowed/);
    expect(caught?.message).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it("rejects a redirect to a private target", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({ status: 302, headers: { location: "http://127.0.0.1/internal" } }),
    );
    await expect(safeFetchJson("https://ex.test/x.json")).rejects.toThrow();
  });

  it("blocks a credential-bearing redirect to another host", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({ status: 302, headers: { location: "https://other.test/collect" } }),
    );
    await expect(
      safeFetchJsonResponse("https://ex.test/me", {
        headers: { authorization: "Bearer fixture-token" },
        allowedRedirectHosts: ["ex.test"],
      }),
    ).rejects.toThrow(/redirect target not allowed/i);
  });

  it("rejects an oversized declared Content-Length", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-length": "10000000000", "content-type": "application/json" },
        bodyText: "{}",
      }),
    );
    await expect(safeFetchJson("https://ex.test/x.json")).rejects.toThrow(/too large/i);
  });

  it("rejects an oversized streamed body when Content-Length is absent", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ status: 200, bodyText: "x".repeat(5000) }));
    await expect(safeFetchJson("https://ex.test/x.json", { maxBytes: 100 })).rejects.toThrow(
      /too large/i,
    );
  });

  it("allows a declared private feed host", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ ok: true }),
      }),
    );
    await expect(
      safeFetchJson("https://mirror.lan/x.json", { allowPrivateHosts: ["mirror.lan"] }),
    ).resolves.toEqual({ ok: true });
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });

  it("never allows a non-HTTP scheme through the private-host escape hatch", async () => {
    await expect(safeFetchJson("file:///etc/passwd", { allowPrivateHosts: ["*"] })).rejects.toThrow(
      /HTTP\(S\)/,
    );
  });
});
