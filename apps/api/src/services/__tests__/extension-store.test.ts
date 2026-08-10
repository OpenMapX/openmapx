import { afterEach, describe, expect, it, vi } from "vitest";

// extension-store imports the db client + redis at module load; neither is used
// by applyLiveVersions (it only calls the injected fetcher), so stub them out.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({ redis: null }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("@openmapx/core/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core/server")>();
  return {
    ...actual,
    safeFetchJson: <T>(url: string, options = {}) =>
      actual.safeFetchJson<T>(url, { ...options, fetchImplementation: globalThis.fetch }),
  };
});

import { lookup as dnsLookup } from "node:dns/promises";
import {
  applyLiveVersions,
  type ExtensionCatalogEntry,
  fetchManifestMeta,
  resolveExtensionManifest,
} from "../extension-store.js";

// dnsLookup has overloads that confuse vi.mocked; cast to a simple mock.
const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;

function entry(over: Partial<ExtensionCatalogEntry>): ExtensionCatalogEntry {
  return { id: "x", name: "X", version: "0.0.0", ...over };
}

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
  for (const response of responses) fn.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  lookupMock.mockReset();
  vi.unstubAllGlobals();
});

describe("applyLiveVersions", () => {
  it("overrides version + platform from the manifest url (the source of truth)", async () => {
    const e = entry({
      manifest: "https://ex/extension.json",
      version: "0.1.0",
      minPlatform: "1.0",
    });
    await applyLiveVersions([e], async () => ({ version: "0.2.0", platform: "1.1" }));
    expect(e.version).toBe("0.2.0");
    expect(e.minPlatform).toBe("1.1");
  });

  it("leaves inline entries (no manifest url) untouched and unfetched", async () => {
    const e = entry({ version: "0.1.0", minPlatform: "1.0" });
    const fetchMeta = vi.fn();
    await applyLiveVersions([e], fetchMeta);
    expect(fetchMeta).not.toHaveBeenCalled();
    expect(e.version).toBe("0.1.0");
  });

  it("falls back to the declared values when the manifest fetch fails", async () => {
    const e = entry({
      manifest: "https://ex/extension.json",
      version: "0.1.0",
      minPlatform: "1.0",
    });
    await applyLiveVersions([e], async () => null);
    expect(e.version).toBe("0.1.0");
    expect(e.minPlatform).toBe("1.0");
  });

  it("keeps the declared platform when the manifest omits it", async () => {
    const e = entry({
      manifest: "https://ex/extension.json",
      version: "0.1.0",
      minPlatform: "1.0",
    });
    await applyLiveVersions([e], async () => ({ version: "0.2.0" }));
    expect(e.version).toBe("0.2.0");
    expect(e.minPlatform).toBe("1.0");
  });

  it("resolves multiple entries concurrently", async () => {
    const a = entry({ id: "a", manifest: "https://ex/a.json", version: "1" });
    const b = entry({ id: "b", manifest: "https://ex/b.json", version: "1" });
    await applyLiveVersions([a, b], async (url) => ({
      version: url.includes("a.json") ? "2" : "3",
    }));
    expect(a.version).toBe("2");
    expect(b.version).toBe("3");
  });

  it("leaves version undefined when a manifest entry has no fallback and the fetch fails", async () => {
    const e = entry({ manifest: "https://ex/extension.json" });
    delete (e as { version?: string }).version;
    await applyLiveVersions([e], async () => null);
    // Never invents a version — the catalog needn't carry one; routes guard undefined.
    expect(e.version).toBeUndefined();
  });
});

describe("fetchManifestMeta (real safeFetchJson SSRF path)", () => {
  it("resolves version/platform on the happy path", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ version: "2.0.0", platform: "1.1" }),
      }),
    );
    await expect(fetchManifestMeta("https://ex.test/extension.json")).resolves.toEqual({
      version: "2.0.0",
      platform: "1.1",
    });
  });

  it("returns null for a private-resolving host without making a network request", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = stubFetchSequence();
    await expect(fetchManifestMeta("https://sneaky.test/extension.json")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when a redirect targets a private/link-local address", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    await expect(fetchManifestMeta("https://ex.test/extension.json")).resolves.toBeNull();
  });
});

describe("resolveExtensionManifest (real safeFetchJson SSRF path)", () => {
  it("rejects a private-resolving manifest host without a network request, IP-free", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = stubFetchSequence();
    const e = entry({
      id: "e",
      name: "E",
      version: "1",
      manifest: "https://sneaky.test/extension.json",
    });
    let caught: Error | undefined;
    try {
      await resolveExtensionManifest(e);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(caught?.message).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it("rejects an oversized manifest response", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        status: 200,
        headers: { "content-length": "10000000000", "content-type": "application/json" },
        bodyText: "{}",
      }),
    );
    const e = entry({
      id: "e",
      name: "E",
      version: "1",
      manifest: "https://ex.test/extension.json",
    });
    await expect(resolveExtensionManifest(e)).rejects.toThrow(/too large/i);
  });
});
