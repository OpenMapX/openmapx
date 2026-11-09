import { randomUUID } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import { clearAdminCache, listAdminCacheNamespaces } from "@openmapx/core/api-admin-sdk";
import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDisposableValkeyFixture } from "../../services/__tests__/support/disposable-valkey-fixture";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

installAdminRouteMocks();
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "scoped cache route with disposable Valkey",
  () => {
    let fixture: Awaited<ReturnType<typeof createDisposableValkeyFixture>>;
    let client: Redis, app: FastifyInstance;
    const scope = `int:parity-${randomUUID()}`,
      foreign = `session:parity-${randomUUID()}`;
    const keys = [`${scope}:a`, `${scope}:b`, `${scope}:other`, foreign];
    beforeAll(async () => {
      fixture = await createDisposableValkeyFixture();
      // The route scans and clears raw key patterns, so it needs an unprefixed client.
      client = new Redis({ ...fixture.options, keyPrefix: "" });
      await client.connect();
      vi.doMock("../../redis", () => ({ redis: client }));
      const { adminCacheRoute } = await import("../admin-cache");
      app = await createAdminTestApp(adminCacheRoute, { prefix: "/api" });
      for (const key of keys) await client.set(key, "synthetic");
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      vi.unstubAllGlobals();
      client?.disconnect();
      await fixture?.stop();
      vi.doUnmock("../../redis");
    }, 30_000);
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
  },
);
