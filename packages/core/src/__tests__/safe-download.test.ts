import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const undiciLifecycle = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
}));
const fileLifecycle = vi.hoisted(() => ({
  actualRename: undefined as typeof import("node:fs/promises")["rename"] | undefined,
  actualRm: undefined as typeof import("node:fs/promises")["rm"] | undefined,
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fileLifecycle.actualRename = actual.rename;
  fileLifecycle.actualRm = actual.rm;
  fileLifecycle.rename.mockImplementation(actual.rename);
  fileLifecycle.rm.mockImplementation(actual.rm);
  return { ...actual, rename: fileLifecycle.rename, rm: fileLifecycle.rm };
});

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    Agent: vi.fn(function PinnedAgent() {
      return { close: undiciLifecycle.close, destroy: undiciLifecycle.destroy };
    }),
    fetch: vi.fn(),
  };
});

// Import AFTER vi.mock so the mocked lookup is captured. We re-import the
// mocked module to drive the mock.
import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import { createPinnedFetchTransport } from "../utils/pinned-fetch";
import {
  assertResolvesToPublicIp,
  SafeFetchHttpError,
  safeDownload,
  safeFetchJson,
  safeFetchJsonResponse,
} from "../utils/safe-download";

// dnsLookup has overloads that confuse vi.mocked; cast to a simple mock.
const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;
const undiciFetchMock = undiciFetch as unknown as ReturnType<typeof vi.fn>;
const renameMock = fileLifecycle.rename;
const rmMock = fileLifecycle.rm;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  vi.useRealTimers();
  lookupMock.mockReset();
  undiciFetchMock.mockReset();
  undiciLifecycle.close.mockReset();
  undiciLifecycle.close.mockResolvedValue(undefined);
  undiciLifecycle.destroy.mockReset();
  undiciLifecycle.destroy.mockResolvedValue(undefined);
  const actualRename = fileLifecycle.actualRename;
  const actualRm = fileLifecycle.actualRm;
  if (!actualRename || !actualRm) throw new Error("safe-download filesystem fixtures unavailable");
  renameMock.mockReset();
  renameMock.mockImplementation(actualRename);
  rmMock.mockReset();
  rmMock.mockImplementation(actualRm);
});

describe("createPinnedFetchTransport cleanup deadlines", () => {
  it("forces a separately bounded destroy when graceful close never settles", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => await new Promise<void>(() => {}));
    const destroy = vi.fn().mockResolvedValue(undefined);
    const response = makeResponse({ bodyText: "archive" });
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy }),
      fetchImplementation: async () => response,
    });
    await transport.fetch(
      "https://origin.test/feed.zip",
      [{ address: "93.184.216.34", family: 4 }],
      {},
    );

    let outcome = "pending";
    const release = transport.releaseResponse(response).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(outcome).toBe("resolved");
    expect(destroy).toHaveBeenCalled();
    await release;
  });

  it("returns within its total budget and retains retry ownership when destroy never settles", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => await new Promise<void>(() => {}));
    const destroy = vi.fn(async () => await new Promise<void>(() => {}));
    const response = makeResponse({ bodyText: "archive" });
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy }),
      fetchImplementation: async () => response,
    });
    await transport.fetch(
      "https://origin.test/feed.zip",
      [{ address: "93.184.216.34", family: 4 }],
      {},
    );

    let outcome = "pending";
    const release = transport.releaseResponse(response).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(outcome).toBe("rejected");
    close.mockResolvedValue(undefined);
    destroy.mockResolvedValue(undefined);
    const recovered = transport.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(recovered).resolves.toBeUndefined();
    await release;
  });
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

  it.each([
    { address: "0.0.0.0", family: 4, label: "IPv4 this-network start" },
    { address: "0.255.255.255", family: 4, label: "IPv4 this-network end" },
    { address: "10.0.0.0", family: 4, label: "IPv4 private start" },
    { address: "10.255.255.255", family: 4, label: "IPv4 private end" },
    { address: "100.64.0.0", family: 4, label: "IPv4 CGNAT start" },
    { address: "100.127.255.255", family: 4, label: "IPv4 CGNAT end" },
    { address: "127.255.255.255", family: 4, label: "IPv4 loopback end" },
    { address: "169.254.0.0", family: 4, label: "IPv4 link-local start" },
    { address: "169.254.255.255", family: 4, label: "IPv4 link-local end" },
    { address: "172.16.0.0", family: 4, label: "IPv4 private /12 start" },
    { address: "172.31.255.255", family: 4, label: "IPv4 private /12 end" },
    { address: "192.0.0.0", family: 4, label: "IPv4 protocol assignments start" },
    { address: "192.0.0.255", family: 4, label: "IPv4 protocol assignments end" },
    { address: "192.0.2.0", family: 4, label: "IPv4 TEST-NET-1 start" },
    { address: "192.0.2.255", family: 4, label: "IPv4 TEST-NET-1 end" },
    { address: "192.88.99.0", family: 4, label: "IPv4 deprecated 6to4 relay start" },
    { address: "192.88.99.255", family: 4, label: "IPv4 deprecated 6to4 relay end" },
    { address: "192.168.0.0", family: 4, label: "IPv4 private /16 start" },
    { address: "192.168.255.255", family: 4, label: "IPv4 private /16 end" },
    { address: "198.18.0.0", family: 4, label: "IPv4 benchmark start" },
    { address: "198.19.255.255", family: 4, label: "IPv4 benchmark end" },
    { address: "198.51.100.0", family: 4, label: "IPv4 TEST-NET-2 start" },
    { address: "198.51.100.255", family: 4, label: "IPv4 TEST-NET-2 end" },
    { address: "203.0.113.0", family: 4, label: "IPv4 TEST-NET-3 start" },
    { address: "203.0.113.255", family: 4, label: "IPv4 TEST-NET-3 end" },
    { address: "224.0.0.0", family: 4, label: "IPv4 multicast start" },
    { address: "239.255.255.255", family: 4, label: "IPv4 multicast end" },
    { address: "240.0.0.0", family: 4, label: "IPv4 reserved start" },
    { address: "255.255.255.255", family: 4, label: "IPv4 limited broadcast" },
    { address: "::", family: 6, label: "IPv6 unspecified" },
    { address: "::1", family: 6, label: "IPv6 loopback" },
    { address: "64:ff9b::a00:1", family: 6, label: "IPv6 translation of private IPv4" },
    { address: "100::1", family: 6, label: "IPv6 discard-only" },
    { address: "2001::1", family: 6, label: "IPv6 special-purpose assignments" },
    {
      address: "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
      family: 6,
      label: "IPv6 special-purpose assignments end",
    },
    { address: "2001:2::1", family: 6, label: "IPv6 benchmarking" },
    { address: "2001:db8::1", family: 6, label: "IPv6 documentation" },
    {
      address: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      family: 6,
      label: "IPv6 documentation end",
    },
    { address: "2002::", family: 6, label: "IPv6 deprecated 6to4 start" },
    {
      address: "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      family: 6,
      label: "IPv6 deprecated 6to4 end",
    },
    { address: "3ffe::1", family: 6, label: "IPv6 former 6bone" },
    { address: "3fff::1", family: 6, label: "IPv6 documentation prefix" },
    {
      address: "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
      family: 6,
      label: "IPv6 documentation prefix end",
    },
    { address: "fc00::1", family: 6, label: "IPv6 ULA start" },
    { address: "fdff:ffff::1", family: 6, label: "IPv6 ULA end" },
    { address: "fe80::1", family: 6, label: "IPv6 link-local start" },
    { address: "fea0::1", family: 6, label: "IPv6 link-local interior" },
    { address: "febf:ffff::1", family: 6, label: "IPv6 link-local end" },
    { address: "fec0::1", family: 6, label: "IPv6 deprecated site-local" },
    { address: "ff02::1", family: 6, label: "IPv6 multicast" },
    { address: "::ffff:127.0.0.1", family: 6, label: "IPv4-mapped dotted loopback" },
    { address: "::ffff:7f00:1", family: 6, label: "IPv4-mapped hexadecimal loopback" },
    {
      address: "0000:0000:0000:0000:0000:ffff:0a00:0001",
      family: 6,
      label: "IPv4-mapped expanded private address",
    },
    { address: "::ffff:6440:1", family: 6, label: "IPv4-mapped hexadecimal CGNAT" },
    { address: "::ffff:c000:201", family: 6, label: "IPv4-mapped TEST-NET" },
  ])("rejects the non-public DNS answer: $label", async ({ address, family }) => {
    lookupMock.mockResolvedValueOnce([{ address, family }]);

    await expect(assertResolvesToPublicIp("fixture.test")).rejects.toThrow(/non-public|private/i);
  });

  it.each([
    { address: "1.0.0.0", family: 4 },
    { address: "100.63.255.255", family: 4 },
    { address: "100.128.0.0", family: 4 },
    { address: "172.15.255.255", family: 4 },
    { address: "172.32.0.0", family: 4 },
    { address: "192.0.1.255", family: 4 },
    { address: "192.0.3.0", family: 4 },
    { address: "198.17.255.255", family: 4 },
    { address: "198.20.0.0", family: 4 },
    { address: "223.255.255.255", family: 4 },
    { address: "2001:200::", family: 6 },
    { address: "3fff:1000::", family: 6 },
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "2a00:1450:4001:801::200e", family: 6 },
    { address: "::ffff:93.184.216.34", family: 6 },
    { address: "::ffff:5db8:d822", family: 6 },
  ])("accepts a representative globally routable DNS answer: $address", async (answer) => {
    lookupMock.mockResolvedValueOnce([answer]);

    await expect(assertResolvesToPublicIp("fixture.test")).resolves.toBeUndefined();
  });

  it("does not disclose a rejected internal address in its error", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.23.45.67", family: 4 }]);

    let error: Error | undefined;
    try {
      await assertResolvesToPublicIp("fixture.test");
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(Error);
    if (!error) throw new Error("expected a rejected internal address");
    expect(error.message).toMatch(/non-public|private/i);
    expect(error.message).not.toContain("10.23.45.67");
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
  it("resolves parsed JSON on the happy path and closes its pinned transport afterward", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ version: "1.2.3" }),
      }),
    );
    await expect(safeFetchJson("https://ex.test/x.json")).resolves.toEqual({ version: "1.2.3" });
    expect(undiciLifecycle.close).toHaveBeenCalledOnce();
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
    expect(undiciLifecycle.close).toHaveBeenCalledOnce();
  });

  it("forces dispatcher destruction when rejecting a response whose cancellation fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence({
      ...makeResponse({ headers: { "content-type": "text/html" } }),
      body: { cancel },
    } as unknown as Response);

    await expect(
      safeFetchJsonResponse("https://ex.test/error", {
        acceptedContentTypes: ["application/json"],
      }),
    ).rejects.toThrow(/content type/i);

    expect(cancel).toHaveBeenCalledOnce();
    expect(undiciLifecycle.destroy).toHaveBeenCalledOnce();
    expect(undiciLifecycle.close).not.toHaveBeenCalled();
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

  it("bounds a never-settling JSON reader cancellation and still settles the transport", async () => {
    vi.useFakeTimers();
    const cancellationStarted = deferred();
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1, 2]) }),
      cancel: vi.fn(() => {
        cancellationStarted.resolve();
        return new Promise<void>(() => {});
      }),
      releaseLock: vi.fn(),
    };
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence({
      ...makeResponse({ status: 200, headers: { "content-type": "application/json" } }),
      body: { getReader: () => reader },
    } as unknown as Response);
    undiciLifecycle.destroy.mockImplementation(async () => await new Promise<void>(() => {}));

    let caught: Error | undefined;
    const operation = safeFetchJsonResponse("https://ex.test/oversized.json", {
      maxBytes: 1,
      timeoutMs: 30,
    }).catch((error) => {
      caught = error as Error;
    });
    await cancellationStarted.promise;
    const destroyCallsBeforeCleanup = undiciLifecycle.destroy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;

    expect(caught?.message).toMatch(/too large/i);
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(undiciLifecycle.destroy.mock.calls.length).toBeGreaterThan(destroyCallsBeforeCleanup);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a JSON reader and cancellation that both ignore the request deadline", async () => {
    vi.useFakeTimers();
    const cancellationStarted = deferred();
    const reader = {
      read: vi.fn(async () => await new Promise<never>(() => {})),
      cancel: vi.fn(async () => {
        cancellationStarted.resolve();
        return await new Promise<void>(() => {});
      }),
      releaseLock: vi.fn(),
    };
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence({
      ...makeResponse({ status: 200, headers: { "content-type": "application/json" } }),
      body: { getReader: () => reader },
    } as unknown as Response);

    let outcome = "pending";
    const operation = safeFetchJsonResponse("https://ex.test/stalled.json", {
      timeoutMs: 30,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(30);
    await cancellationStarted.promise;
    const destroyCallsBeforeCleanup = undiciLifecycle.destroy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;

    expect(outcome).toBe("rejected");
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(undiciLifecycle.destroy.mock.calls.length).toBeGreaterThan(destroyCallsBeforeCleanup);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the repeated connection-time DNS lookup with the total request timeout", async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockImplementationOnce(async () => await new Promise<never>(() => {}));
    const fetchMock = stubFetchSequence();
    let outcome = "pending";
    const operation = safeFetchJsonResponse("https://ex.test/stalled-dns.json", {
      timeoutMs: 30,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    const settled = await settlesWithin(operation, 100);

    expect(settled).toBe(true);
    expect(outcome).toBe("rejected");
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    await operation;
  });

  it("bounds a never-settling redirect-hop DNS lookup after releasing the redirect", async () => {
    const redirectCancel = vi.fn().mockResolvedValue(undefined);
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockImplementationOnce(async () => await new Promise<never>(() => {}));
    const fetchMock = stubFetchSequence({
      ...makeResponse({
        status: 302,
        headers: { location: "https://redirect.test/final.json" },
      }),
      body: { cancel: redirectCancel },
    } as unknown as Response);
    let outcome = "pending";
    const operation = safeFetchJsonResponse("https://ex.test/redirect.json", {
      timeoutMs: 30,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    const settled = await settlesWithin(operation, 100);

    expect(settled).toBe(true);
    expect(outcome).toBe("rejected");
    expect(lookupMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(redirectCancel).toHaveBeenCalledOnce();
    expect(undiciLifecycle.close).toHaveBeenCalledOnce();
    await operation;
  });

  it("bounds final-host DNS revalidation and cleans up the acquired response", async () => {
    const bodyCancel = vi.fn().mockResolvedValue(undefined);
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockImplementationOnce(async () => await new Promise<never>(() => {}));
    stubFetchSequence({
      ...makeResponse({ status: 200, url: "https://final.test/data.json" }),
      body: { cancel: bodyCancel },
    } as unknown as Response);
    let outcome = "pending";
    const operation = safeFetchJsonResponse("https://ex.test/data.json", {
      timeoutMs: 30,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    const settled = await settlesWithin(operation, 100);

    expect(settled).toBe(true);
    expect(outcome).toBe("rejected");
    expect(lookupMock).toHaveBeenCalledTimes(3);
    expect(bodyCancel).toHaveBeenCalledOnce();
    expect(undiciLifecycle.close).toHaveBeenCalledOnce();
    await operation;
  });

  it("uses caller abort to stop a never-settling connection-time DNS lookup", async () => {
    const secondLookupStarted = deferred();
    const controller = new AbortController();
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockImplementationOnce(async () => {
        secondLookupStarted.resolve();
        return await new Promise<never>(() => {});
      });
    const fetchMock = stubFetchSequence();
    let outcome = "pending";
    const operation = safeFetchJsonResponse("https://ex.test/aborted-dns.json", {
      timeoutMs: 10_000,
      signal: controller.signal,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await secondLookupStarted.promise;

    controller.abort(new Error("fixture abort"));
    const settled = await settlesWithin(operation, 100);

    expect(settled).toBe(true);
    expect(outcome).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
    await operation;
  });

  it("does not start initial DNS validation after caller abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture abort"));
    const fetchMock = stubFetchSequence();

    await expect(
      safeFetchJsonResponse("https://ex.test/aborted-before-dns.json", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/fixture abort/i);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("safeDownload", () => {
  it("streams a successful response before closing its pinned transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destPath = join(directory, "fixture.json");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        headers: { "content-type": "application/json" },
        bodyText: '{"ok":true}',
      }),
    );

    try {
      await expect(
        safeDownload({
          url: new URL("https://ex.test/fixture.json"),
          destination: destPath,
          timeoutMs: 5 * 60_000,
          maxBytes: 2 * 1024 * 1024 * 1024,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).resolves.toEqual({
        bytesWritten: 11,
        contentType: "application/json",
        finalUrl: new URL("https://ex.test/fixture.json"),
      });
      await expect(readFile(destPath, "utf8")).resolves.toBe('{"ok":true}');
      expect(undiciLifecycle.close).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("forces dispatcher destruction when an HTTP-error body cannot be canceled", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence({
      ...makeResponse({ status: 503 }),
      body: { cancel },
    } as unknown as Response);

    await expect(
      safeDownload({
        url: new URL("https://ex.test/unavailable"),
        destination: "/tmp/unused-download.json",
        timeoutMs: 5 * 60_000,
        maxBytes: 2 * 1024 * 1024 * 1024,
        allowedContentTypes: [],
        credentialPolicy: "none",
      }),
    ).rejects.toThrow(/download failed/i);

    expect(cancel).toHaveBeenCalledOnce();
    expect(undiciLifecycle.destroy).toHaveBeenCalledOnce();
    expect(undiciLifecycle.close).not.toHaveBeenCalled();
  });

  it("revalidates and pins a valid public redirect before atomically publishing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 302,
        headers: { location: "https://cdn.test/feed.zip" },
        url: "https://origin.test/feed.zip",
      }),
      makeResponse({
        headers: { "content-type": "application/zip" },
        bodyText: "archive",
        url: "https://cdn.test/feed.zip",
      }),
    );

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: ["application/zip"],
          credentialPolicy: "none",
        }),
      ).resolves.toEqual({
        bytesWritten: 7,
        contentType: "application/zip",
        finalUrl: new URL("https://cdn.test/feed.zip"),
      });
      await expect(readFile(destination, "utf8")).resolves.toBe("archive");
      await expect(readdir(directory)).resolves.toEqual(["feed.zip"]);
      expect(lookupMock).toHaveBeenCalledTimes(3);
      expect(undiciFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("bounds a never-settling redirect-body cancellation before forcing the hop closed", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const cancelStarted = deferred();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      {
        ...makeResponse({
          status: 302,
          headers: { location: "https://origin.test/final.zip" },
          url: "https://origin.test/feed.zip",
        }),
        body: {
          cancel: vi.fn(() => {
            cancelStarted.resolve();
            return new Promise<void>(() => {});
          }),
        },
      } as unknown as Response,
      makeResponse({
        bodyText: "archive",
        url: "https://origin.test/final.zip",
      }),
    );

    try {
      const operation = safeDownload({
        url: new URL("https://origin.test/feed.zip"),
        destination,
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: [],
        credentialPolicy: "none",
      });
      await cancelStarted.promise;
      await vi.advanceTimersByTimeAsync(500);
      await expect(operation).resolves.toMatchObject({ bytesWritten: 7 });
      expect(undiciLifecycle.destroy).toHaveBeenCalled();
      await expect(readFile(destination, "utf8")).resolves.toBe("archive");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["http://127.0.0.1/internal", "http://169.254.169.254/latest/meta-data"])(
    "rejects a redirect to a special address before connecting: %s",
    async (location) => {
      const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
      const destination = join(directory, "feed.zip");
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      stubFetchSequence(makeResponse({ status: 302, headers: { location } }));

      try {
        await expect(
          safeDownload({
            url: new URL("https://origin.test/feed.zip"),
            destination,
            timeoutMs: 1_000,
            maxBytes: 32,
            allowedContentTypes: [],
            credentialPolicy: "none",
          }),
        ).rejects.toThrow(/private|internal/i);
        await expect(readdir(directory)).resolves.toEqual([]);
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it("rejects mixed public/private DNS answers before opening a connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    try {
      await expect(
        safeDownload({
          url: new URL("https://mixed.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/private|internal/i);
      expect(undiciFetchMock).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when connection-time DNS differs from validation-time DNS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);

    try {
      await expect(
        safeDownload({
          url: new URL("https://rebind.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/private|internal/i);
      expect(undiciFetchMock).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a credential-bearing cross-origin redirect before forwarding headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 302,
        headers: { location: "https://cdn.test/feed.zip" },
        url: "https://origin.test/feed.zip",
      }),
    );

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          headers: { authorization: "Bearer fixture-credential" },
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "same-origin",
        }),
      ).rejects.toThrow(/origin not allowed/i);
      expect(undiciFetchMock).toHaveBeenCalledTimes(1);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("strips URL credentials and credential headers under the none policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        headers: { "content-type": "application/zip" },
        bodyText: "archive",
        url: "https://origin.test/feed.zip",
      }),
    );

    try {
      await safeDownload({
        url: new URL("https://user:fixture-password@origin.test/feed.zip"),
        destination,
        headers: {
          authorization: "Bearer fixture-credential",
          cookie: "session=fixture",
          "user-agent": "OpenMapX test",
        },
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: ["application/zip"],
        credentialPolicy: "none",
      });

      const [requestedUrl, init] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestedUrl).toBe("https://origin.test/feed.zip");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("user-agent")).toBe("OpenMapX test");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects an oversized stream and removes every partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "x".repeat(64) }));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 16,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/max size|too large/i);
      await expect(readdir(directory)).resolves.toEqual([]);
      expect(undiciLifecycle.destroy).toHaveBeenCalled();
      expect(undiciLifecycle.close).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("settles the dispatcher when opening the destination writer fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "missing", "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "archive" }));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/ENOENT|no such file|missing/i);
      expect(undiciLifecycle.destroy).toHaveBeenCalledOnce();
      expect(undiciLifecycle.close).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects unsupported response content types before publishing a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({ headers: { "content-type": "text/html" }, bodyText: "not an archive" }),
    );

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: ["application/zip"],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/content type/i);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("honors caller abort and leaves no partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const controller = new AbortController();
    controller.abort(new Error("operator canceled"));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/operator canceled|abort/i);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(undiciFetchMock).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("applies one total timeout and removes every partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    undiciFetchMock.mockImplementation(
      async (_input: string, init: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 5,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/timeout|abort/i);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("applies the total timeout while the initial DNS resolution is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockImplementation(async () => await new Promise(() => {}));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 5,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/timeout|abort/i);
      expect(undiciFetchMock).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 250);

  it("preserves a socket-setup error when dispatcher cleanup also fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const recoveredDestination = join(directory, "recovered.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    undiciFetchMock.mockRejectedValueOnce(new Error("socket setup failed"));
    undiciLifecycle.close.mockRejectedValue(new Error("close denied"));
    undiciLifecycle.destroy.mockRejectedValue(new Error("destroy denied"));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow("socket setup failed");
      await expect(readdir(directory)).resolves.toEqual([]);

      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      stubFetchSequence(makeResponse({ bodyText: "recovered" }));
      await safeDownload({
        url: new URL("https://origin.test/recovered.zip"),
        destination: recoveredDestination,
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: [],
        credentialPolicy: "none",
      });
      await expect(readFile(recoveredDestination, "utf8")).resolves.toBe("recovered");
    } finally {
      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not publish a destination when dispatcher settlement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const recoveredDestination = join(directory, "recovered.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "archive" }));
    undiciLifecycle.close.mockRejectedValue(new Error("close denied"));
    undiciLifecycle.destroy.mockRejectedValue(new Error("destroy denied"));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/cleanup|dispatcher|close|destroy/i);
      await expect(readdir(directory)).resolves.toEqual([]);

      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      stubFetchSequence(makeResponse({ bodyText: "recovered" }));
      await safeDownload({
        url: new URL("https://origin.test/recovered.zip"),
        destination: recoveredDestination,
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: [],
        credentialPolicy: "none",
      });
      await expect(readFile(recoveredDestination, "utf8")).resolves.toBe("recovered");
    } finally {
      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("attempts temp cleanup despite a body error and dispatcher cleanup errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "x".repeat(64) }));
    undiciLifecycle.close.mockRejectedValue(new Error("close denied"));
    undiciLifecycle.destroy.mockRejectedValue(new Error("destroy denied"));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 8,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/max size|too large/i);
      await expect(readdir(directory)).resolves.toEqual([]);
      expect(undiciLifecycle.destroy).toHaveBeenCalled();
      expect(undiciLifecycle.close).not.toHaveBeenCalled();
    } finally {
      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves a rename error while still attempting every cleanup resource", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const actualRm = fileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    let partialAttempts = 0;
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes(".part-") && partialAttempts < 3) {
        partialAttempts += 1;
        throw new Error("rm denied");
      }
      return actualRm(path, options);
    });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "archive" }));
    renameMock.mockRejectedValueOnce(new Error("rename denied"));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow("rename denied");
      expect(partialAttempts).toBe(3);
      expect(await readdir(directory)).toHaveLength(1);

      const controller = new AbortController();
      controller.abort(new Error("fixture canceled"));
      await expect(
        safeDownload({
          url: new URL("https://origin.test/second.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 32,
          allowedContentTypes: [],
          credentialPolicy: "none",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/fixture canceled/);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      rmMock.mockImplementation(actualRm);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retains ownership after bounded rm failures and scavenges the partial on the next call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const actualRm = fileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    let partialAttempts = 0;
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes(".part-") && partialAttempts < 3) {
        partialAttempts += 1;
        throw new Error("rm denied");
      }
      return actualRm(path, options);
    });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "x".repeat(64) }));

    try {
      await expect(
        safeDownload({
          url: new URL("https://origin.test/feed.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 8,
          allowedContentTypes: [],
          credentialPolicy: "none",
        }),
      ).rejects.toThrow(/max size|too large/i);
      expect(partialAttempts).toBe(3);
      expect(await readdir(directory)).toHaveLength(1);

      const controller = new AbortController();
      controller.abort(new Error("fixture canceled"));
      await expect(
        safeDownload({
          url: new URL("https://origin.test/second.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 8,
          allowedContentTypes: [],
          credentialPolicy: "none",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/fixture canceled/);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      rmMock.mockImplementation(actualRm);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("bounds a never-settling body cancellation and still destroys the dispatcher", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const cancelStarted = deferred();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence({
      ...makeResponse({ headers: { "content-type": "text/html" } }),
      body: {
        cancel: vi.fn(() => {
          cancelStarted.resolve();
          return new Promise<void>(() => {});
        }),
      },
    } as unknown as Response);

    try {
      let caught: Error | undefined;
      const operation = safeDownload({
        url: new URL("https://origin.test/feed.zip"),
        destination,
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: ["application/zip"],
        credentialPolicy: "none",
      }).catch((error) => {
        caught = error as Error;
      });
      await cancelStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await operation;

      expect(caught?.message).toMatch(/content type/i);
      expect(undiciLifecycle.destroy).toHaveBeenCalled();
      expect(existsSync(destination)).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not publish when dispatcher release never settles and still removes the partial", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const recoveredDestination = join(directory, "recovered.zip");
    const cleanupStarted = deferred();
    const partialRemovalStarted = deferred();
    const actualRm = fileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "archive" }));
    undiciLifecycle.close.mockImplementation(async () => {
      cleanupStarted.resolve();
      return await new Promise<void>(() => {});
    });
    undiciLifecycle.destroy.mockImplementation(async () => await new Promise<void>(() => {}));
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes(".part-")) {
        partialRemovalStarted.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      return actualRm(path, options);
    });

    try {
      let outcome = "pending";
      let caught: Error | undefined;
      const operation = safeDownload({
        url: new URL("https://origin.test/feed.zip"),
        destination,
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: [],
        credentialPolicy: "none",
      }).catch((error) => {
        caught = error as Error;
        outcome = "rejected";
      });
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(1_500);
      await partialRemovalStarted.promise;
      await Promise.resolve();
      expect(outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(10_000);
      await operation;

      expect(caught?.message).toMatch(/cleanup|deadline|dispatcher/i);
      expect(existsSync(destination)).toBe(false);
      expect(await readdir(directory)).toHaveLength(0);

      vi.useRealTimers();
      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      stubFetchSequence(makeResponse({ bodyText: "recovered" }));
      const recovery = safeDownload({
        url: new URL("https://origin.test/recovered.zip"),
        destination: recoveredDestination,
        timeoutMs: 1_000,
        maxBytes: 32,
        allowedContentTypes: [],
        credentialPolicy: "none",
      });
      await expect(recovery).resolves.toMatchObject({ bytesWritten: 9 });
      await expect(readdir(directory)).resolves.toEqual(["recovered.zip"]);
    } finally {
      undiciLifecycle.close.mockReset().mockResolvedValue(undefined);
      undiciLifecycle.destroy.mockReset().mockResolvedValue(undefined);
      rmMock.mockImplementation(actualRm);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("returns the primary error when partial deletion never settles and scavenges later", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "openmapx-safe-download-"));
    const destination = join(directory, "feed.zip");
    const actualRm = fileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    const cleanupStarted = deferred();
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes(".part-")) {
        cleanupStarted.resolve();
        return await new Promise<void>(() => {});
      }
      return actualRm(path, options);
    });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(makeResponse({ bodyText: "x".repeat(64) }));

    try {
      let caught: Error | undefined;
      const operation = safeDownload({
        url: new URL("https://origin.test/feed.zip"),
        destination,
        timeoutMs: 1_000,
        maxBytes: 8,
        allowedContentTypes: [],
        credentialPolicy: "none",
      }).catch((error) => {
        caught = error as Error;
      });
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await operation;

      expect(caught?.message).toMatch(/max size|too large/i);
      expect(caught?.cause).toBeInstanceOf(AggregateError);
      expect(await readdir(directory)).toHaveLength(1);

      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      const controller = new AbortController();
      controller.abort(new Error("fixture canceled"));
      await expect(
        safeDownload({
          url: new URL("https://origin.test/retry.zip"),
          destination,
          timeoutMs: 1_000,
          maxBytes: 8,
          allowedContentTypes: [],
          credentialPolicy: "none",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/fixture canceled/);
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      rmMock.mockImplementation(actualRm);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
