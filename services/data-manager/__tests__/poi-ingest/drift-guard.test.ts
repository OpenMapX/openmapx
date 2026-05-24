import { createHash } from "node:crypto";
import {
  __clearPoiSourceRegistry,
  type PoiStaticParseFn,
  registerPoiSource,
} from "@openmapx/poi-source-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDriftGuard } from "../../src/jobs/poi-ingest/drift-guard.js";

const staticParse: PoiStaticParseFn = function* () {};

function registerIds(ids: readonly string[]) {
  for (const id of ids) {
    registerPoiSource({
      id,
      domain: "ev-charging",
      name: id,
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: "https://example.test" },
        parse: staticParse,
      },
    });
  }
}

function hashOf(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join("\n"))
    .digest("hex");
}

function mockFetchOk(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  __clearPoiSourceRegistry();
});

describe("createDriftGuard", () => {
  it("returns true when hash matches", async () => {
    registerIds(["src-a", "src-b"]);
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: mockFetchOk({ count: 2, hash: hashOf(["src-a", "src-b"]) }),
    });
    const r = await guard.check();
    expect(r.registryCountMatchesUpstream).toBe(true);
    expect(r.local.count).toBe(2);
    expect(r.upstream?.count).toBe(2);
  });

  it("returns false when hash differs (same count, different ids)", async () => {
    registerIds(["src-a", "src-b"]);
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: mockFetchOk({ count: 2, hash: hashOf(["src-a", "src-c"]) }),
    });
    const r = await guard.check();
    expect(r.registryCountMatchesUpstream).toBe(false);
    expect(r.reason).toMatch(/same count but different/);
  });

  it("returns false when counts differ", async () => {
    registerIds(["src-a", "src-b"]);
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: mockFetchOk({ count: 3, hash: hashOf(["src-a", "src-b", "src-c"]) }),
    });
    const r = await guard.check();
    expect(r.registryCountMatchesUpstream).toBe(false);
    expect(r.reason).toMatch(/count differs.*local=2.*upstream=3/);
  });

  it('returns "unknown" when upstream is unreachable', async () => {
    registerIds(["src-a"]);
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const r = await guard.check();
    expect(r.registryCountMatchesUpstream).toBe("unknown");
    expect(r.upstream).toBeNull();
    expect(r.reason).toBe("apps/api unreachable");
  });

  it('returns "unknown" when upstream returns non-2xx', async () => {
    registerIds(["src-a"]);
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const guard = createDriftGuard({ appApiBaseUrl: "http://app-api:3001", fetch: fetchFn });
    const r = await guard.check();
    expect(r.registryCountMatchesUpstream).toBe("unknown");
  });

  it('returns "unknown" when upstream payload is malformed', async () => {
    registerIds(["src-a"]);
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: mockFetchOk({ unexpected: true }),
    });
    const r = await guard.check();
    expect(r.registryCountMatchesUpstream).toBe("unknown");
  });

  it("caches upstream within the TTL window", async () => {
    registerIds(["src-a"]);
    const fetchFn = vi.fn(mockFetchOk({ count: 1, hash: hashOf(["src-a"]) }));
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: fetchFn,
      cacheTtlMs: 5_000,
    });
    await guard.check();
    await guard.check();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("__clearCache forces a re-fetch", async () => {
    registerIds(["src-a"]);
    const fetchFn = vi.fn(mockFetchOk({ count: 1, hash: hashOf(["src-a"]) }));
    const guard = createDriftGuard({
      appApiBaseUrl: "http://app-api:3001",
      fetch: fetchFn,
    });
    await guard.check();
    guard.__clearCache();
    await guard.check();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
