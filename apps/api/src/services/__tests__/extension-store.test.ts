import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const CATALOG_LOG_FIXTURE = vi.hoisted(() => {
  const previous = process.env.EXTENSION_CATALOG_URL;
  const url =
    "https://fixture-user:fixture-pass@catalog.example.test/private/catalog.json?token=fixture-catalog-token#fixture-fragment";
  process.env.EXTENSION_CATALOG_URL = url;
  return { previous, url };
});

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
    safeFetchText: (url: string, options = {}) =>
      actual.safeFetchText(url, { ...options, fetchImplementation: globalThis.fetch }),
  };
});

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { appLogger } from "../app-logger.js";
import {
  applyLiveVersions,
  type ExtensionCatalogEntry,
  fetchManifestMeta,
  getExtensionCatalog,
  isImmutableCatalogUrl,
  resolveEntryTrust,
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

afterAll(() => {
  if (CATALOG_LOG_FIXTURE.previous === undefined) delete process.env.EXTENSION_CATALOG_URL;
  else process.env.EXTENSION_CATALOG_URL = CATALOG_LOG_FIXTURE.previous;
});

describe("catalog failure logging", () => {
  it("retains only a branded source host/digest and error class", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = appLogger.getEntries({ source: "extension-store" }).total;

    await getExtensionCatalog(true);

    const result = appLogger.getEntries({ source: "extension-store" });
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(result.total).toBe(before + 1);
    expect(result.entries[0]).toMatchObject({
      level: "warn",
      source: "extension-store",
      msg: "Extension catalog fetch failed",
      metadata: {
        catalogSource: {
          host: "catalog.example.test",
          digest: "01c5ebfa90591d0c804bb58ff0ab45bf",
        },
        errorClass: "Error",
      },
    });
    expect(JSON.stringify(result.entries[0])).not.toMatch(
      /fixture-user|fixture-pass|private\/catalog|fixture-catalog-token|fixture-fragment/,
    );
    consoleWarn.mockRestore();
  });
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

describe("immutable verified trust", () => {
  it("treats only an exact 40-hex commit path as immutable", () => {
    expect(
      isImmutableCatalogUrl(
        "https://raw.githubusercontent.com/openmapx/community-extensions/254ed34c34f204809870323e7dca6389e0d6f81f/catalog.json",
      ),
    ).toBe(true);
    expect(
      isImmutableCatalogUrl(
        "https://raw.githubusercontent.com/openmapx/community-extensions/main/catalog.json",
      ),
    ).toBe(false);
    expect(
      isImmutableCatalogUrl(
        "https://raw.githubusercontent.com/openmapx/community-extensions/v1.2.3/catalog.json",
      ),
    ).toBe(false);
    // A short SHA is not a full object id.
    expect(isImmutableCatalogUrl("https://example.test/254ed34/catalog.json")).toBe(false);
  });

  const immutableSource = {
    url: "https://example.test/254ed34c34f204809870323e7dca6389e0d6f81f/catalog.json",
    label: "OpenMapX Community",
    isDefault: true,
  };
  const pinnedEntry = {
    id: "openconditions",
    version: "1.0.0",
    manifest: "https://example.test/extension.json",
    manifestSha256: "d".repeat(64),
    platform: "1.0",
  };

  it("grants verified trust only to a digest-pinned entry from an immutable default", () => {
    expect(resolveEntryTrust(immutableSource, pinnedEntry).trust).toBe("verified");
  });

  it("refuses verified trust to an entry with no manifest digest", () => {
    const { manifestSha256, ...unpinned } = pinnedEntry;
    expect(resolveEntryTrust(immutableSource, unpinned).trust).toBe("community");
  });

  it("refuses verified trust when the default catalog itself can move", () => {
    expect(
      resolveEntryTrust(
        { ...immutableSource, url: "https://example.test/main/catalog.json" },
        pinnedEntry,
      ).trust,
    ).toBe("community");
  });

  it("refuses verified trust to any non-default source, however well pinned", () => {
    expect(resolveEntryTrust({ ...immutableSource, isDefault: false }, pinnedEntry).trust).toBe(
      "community",
    );
  });

  it("ignores a trust field the feed tries to declare for itself", () => {
    expect(resolveEntryTrust(immutableSource, { ...pinnedEntry, trust: "verified" }).trust).toBe(
      "verified",
    );
    // The smuggled field is not part of the authorization decision.
    expect(
      resolveEntryTrust(immutableSource, {
        ...pinnedEntry,
        manifestSha256: undefined,
        trust: "verified",
      }).trust,
    ).toBe("community");
  });
});

describe("digest-bound manifest resolution", () => {
  const MANIFEST = JSON.stringify({
    id: "ext-one",
    name: "Ext One",
    version: "1.0.0",
    integrations: [
      { artifact: "https://example.test/a.tar.gz", sha256: "a".repeat(64), id: "intg-one" },
    ],
  });
  const DIGEST = createHash("sha256").update(MANIFEST, "utf8").digest("hex");

  function stubManifestResponse(body: string) {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetchSequence(
      makeResponse({
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        bodyText: body,
      }),
    );
  }

  it("accepts a manifest whose bytes match the pinned digest", async () => {
    stubManifestResponse(MANIFEST);
    await expect(
      resolveExtensionManifest(
        entry({
          id: "ext-one",
          version: "1.0.0",
          manifest: "https://example.test/extension.json",
          manifestSha256: DIGEST,
          trust: "verified",
        }),
      ),
    ).resolves.toMatchObject({ id: "ext-one", version: "1.0.0" });
  });

  it("rejects manifest bytes that do not match the pinned digest", async () => {
    stubManifestResponse(MANIFEST.replace('"1.0.0"', '"9.9.9"'));
    await expect(
      resolveExtensionManifest(
        entry({
          id: "ext-one",
          version: "1.0.0",
          manifest: "https://example.test/extension.json",
          manifestSha256: DIGEST,
          trust: "verified",
        }),
      ),
    ).rejects.toThrow(/digest mismatch/i);
  });

  it("refuses to resolve a verified entry that carries no digest", async () => {
    await expect(
      resolveExtensionManifest(
        entry({
          id: "ext-one",
          manifest: "https://example.test/extension.json",
          trust: "verified",
        }),
      ),
    ).rejects.toThrow(/missing its manifest digest/i);
  });

  it("rejects a manifest whose id does not match the catalog entry", async () => {
    const body = MANIFEST.replace('"ext-one"', '"ext-other"');
    stubManifestResponse(body);
    await expect(
      resolveExtensionManifest(
        entry({
          id: "ext-one",
          manifest: "https://example.test/extension.json",
          manifestSha256: createHash("sha256").update(body, "utf8").digest("hex"),
          trust: "verified",
        }),
      ),
    ).rejects.toThrow(/id does not match/i);
  });

  it("rejects a manifest whose version does not match the authorized entry version", async () => {
    stubManifestResponse(MANIFEST);
    await expect(
      resolveExtensionManifest(
        entry({
          id: "ext-one",
          version: "2.0.0",
          manifest: "https://example.test/extension.json",
          manifestSha256: DIGEST,
          trust: "verified",
        }),
      ),
    ).rejects.toThrow(/version does not match/i);
  });
});

describe("applyLiveVersions trust boundary", () => {
  it("never lets a moving manifest url choose a verified entry's version", async () => {
    const fetchMeta = vi.fn().mockResolvedValue({ version: "9.9.9", platform: "9.0" });
    const verified = entry({
      id: "v",
      version: "1.0.0",
      minPlatform: "1.0",
      manifest: "https://example.test/latest/extension.json",
      manifestSha256: "e".repeat(64),
      trust: "verified",
    });
    const community = entry({
      id: "c",
      version: "1.0.0",
      manifest: "https://example.test/latest/extension.json",
      trust: "community",
    });

    await applyLiveVersions([verified, community], fetchMeta);

    expect(verified.version).toBe("1.0.0");
    expect(verified.minPlatform).toBe("1.0");
    expect(community.version).toBe("9.9.9");
    expect(fetchMeta).toHaveBeenCalledTimes(1);
  });
});
