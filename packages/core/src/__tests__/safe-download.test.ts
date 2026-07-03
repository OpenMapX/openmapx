import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

// Import AFTER vi.mock so the mocked lookup is captured. We re-import the
// mocked module to drive the mock.
import { lookup as dnsLookup } from "node:dns/promises";
import { assertResolvesToPublicIp, safeFetchJson } from "../utils/safe-download";

// dnsLookup has overloads that confuse vi.mocked; cast to a simple mock.
const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  lookupMock.mockReset();
});

describe("assertResolvesToPublicIp", () => {
  it("passes for a public IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
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
}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: "",
    headers: new Headers(opts.headers ?? {}),
    body: new Response(opts.bodyText ?? "").body,
  } as unknown as Response;
}

function stubFetchSequence(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("safeFetchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves parsed JSON on the happy path", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ version: "1.2.3" }),
      }),
    );
    await expect(safeFetchJson("https://ex.test/x.json")).resolves.toEqual({ version: "1.2.3" });
  });

  it("rejects a private-resolving host before any network request", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = stubFetchSequence();
    await expect(safeFetchJson("https://sneaky.test/x.json")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
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
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({ status: 302, headers: { location: "http://127.0.0.1/internal" } }),
    );
    await expect(safeFetchJson("https://ex.test/x.json")).rejects.toThrow();
  });

  it("rejects an oversized declared Content-Length", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
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
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ status: 200, bodyText: "x".repeat(5000) }));
    await expect(safeFetchJson("https://ex.test/x.json", { maxBytes: 100 })).rejects.toThrow(
      /too large/i,
    );
  });
});
