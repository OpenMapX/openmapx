import { randomUUID } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import { clearAdminCache, listAdminCacheNamespaces } from "@openmapx/core/api-admin-sdk";
import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

installAdminRouteMocks();
const url = process.env.OPENMAPX_TEST_VALKEY_URL;
describe.skipIf(!url)("scoped cache route with disposable Valkey", () => {
  let client: Redis, app: FastifyInstance;
  const scope = `int:parity-${randomUUID()}`,
    foreign = `session:parity-${randomUUID()}`;
  const keys = [`${scope}:a`, `${scope}:b`, `${scope}:other`, foreign];
  beforeAll(async () => {
    client = new Redis(url as string, { lazyConnect: true, enableOfflineQueue: false, db: 1 });
    await client.connect();
    vi.doMock("../../redis", () => ({ redis: client }));
    const { adminCacheRoute } = await import("../admin-cache");
    app = await createAdminTestApp(adminCacheRoute, { prefix: "/api" });
    for (const key of keys) await client.set(key, "synthetic");
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    if (client) {
      await client.del(...keys);
      await client.quit();
    }
    vi.doUnmock("../../redis");
  });
  it("previews Redis bracket globs without epochs, then deletes only matching application keys", async () => {
    const epochBefore = await client.get("openmapx:cache-control:epoch"),
      pattern = `${scope}:[ab]`;
    vi.stubGlobal("fetch", administrationSdkFetch(app));
    const options = { client: createApiClient({ baseUrl: "https://app.test" }) };
    const preview = await clearAdminCache({ pattern, dryRun: true }, options);
    expect(preview.status).toBe(200);
    expect(preview.data).toEqual({ dryRun: true, estimatedCount: 2, patterns: [pattern] });
    expect(await client.get("openmapx:cache-control:epoch")).toBe(epochBefore);
    expect(await client.mget(...keys)).toEqual(keys.map(() => "synthetic"));
    const clear = await clearAdminCache({ pattern }, options);
    expect(clear.status).toBe(200);
    expect(clear.data).toEqual({ deleted: 2, patterns: [pattern] });
    const list = await listAdminCacheNamespaces(options);
    expect(list.status).toBe(200);
    expect(list.data).toEqual({ namespaces: [{ namespace: scope, keyCount: 1 }] });
    expect(await client.mget(...keys)).toEqual([null, null, "synthetic", "synthetic"]);
    expect(Number(await client.get("openmapx:cache-control:epoch"))).toBeGreaterThan(
      Number(epochBefore ?? 0),
    );
  });
});
