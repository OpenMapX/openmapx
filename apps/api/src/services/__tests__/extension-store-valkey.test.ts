import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  editExtensionSources,
  publishExtensionCatalog,
  readExtensionSnapshot,
} from "../extension-store-cache";

import { createDisposableValkeyFixture as createFixture } from "./support/disposable-valkey-fixture";

const ports = vi.hoisted(() => ({ client: null as Redis | null, fetch: vi.fn() }));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({
  get redis() {
    return ports.client;
  },
}));
vi.mock("@openmapx/core/server", async (original) => ({
  ...(await original<typeof import("@openmapx/core/server")>()),
  safeFetchJson: (...args: unknown[]) => ports.fetch(...args),
}));
vi.mock("../app-logger", () => ({ appLogger: { add: vi.fn() } }));

import { addExtensionSource, getExtensionCatalog, removeExtensionSource } from "../extension-store";

// Positive mode fails if Docker or the exact cached image is unavailable. No
// application URL/password/ACL/envfile is consulted, and no image may be pulled.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "extension cache on pinned Valkey",
  () => {
    let fixture: Awaited<ReturnType<typeof createFixture>>;
    const keys = { sources: "sources", catalog: "catalog" };
    const empty = '{"entries":[],"killSwitch":{"removed":[],"critical":[]}}';
    beforeAll(async () => {
      fixture = await createFixture();
      ports.client = fixture.client;
    }, 60_000);
    afterAll(async () => {
      try {
        ports.client = null;
      } finally {
        await fixture?.stop();
      }
    }, 30_000);
    beforeEach(async () => {
      await fixture.client.del(
        keys.sources,
        keys.catalog,
        "extstore:extra_sources",
        "extstore:catalog",
      );
      ports.fetch.mockReset().mockResolvedValue([]);
    });

    it("runs the production-pinned runtime and atomically edits/publishes with the original payloads", async () => {
      expect(await fixture.client.info("server")).toMatch(/valkey_version:9\.1\.3\r?\n/);
      await fixture.client.set(keys.catalog, "old");
      await editExtensionSources(fixture.client, keys, null, "[]");
      expect(await fixture.client.get(keys.catalog)).toBeNull();
      expect(await fixture.client.get(keys.sources)).toBe("[]");
      expect(await fixture.client.ttl(keys.sources)).toBe(-1);
      await publishExtensionCatalog(fixture.client, keys, "[]", null, empty, 86400);
      expect(await fixture.client.get(keys.catalog)).toBe(empty);
      expect(await fixture.client.ttl(keys.catalog)).toBeGreaterThan(0);
      expect(await fixture.client.ttl(keys.catalog)).toBeLessThanOrEqual(86400);
    });

    it("compares exact bytes and distinguishes absence, empty bytes and an empty array", async () => {
      await fixture.client.set(keys.sources, "");
      await fixture.client.set(keys.catalog, "old");
      await expect(editExtensionSources(fixture.client, keys, null, "[]")).rejects.toMatchObject({
        category: "source_conflict",
      });
      expect(await fixture.client.get(keys.catalog)).toBe("old");
      await editExtensionSources(fixture.client, keys, "", "[ ]");
      await expect(editExtensionSources(fixture.client, keys, "[]", "next")).rejects.toMatchObject({
        category: "source_conflict",
      });
      expect(await fixture.client.get(keys.sources)).toBe("[ ]");
    });

    it("preserves a completed competing edit and fences both kinds of obsolete publication", async () => {
      const results = await Promise.allSettled([
        editExtensionSources(fixture.client, keys, null, "first"),
        editExtensionSources(fixture.client, keys, null, "second"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toMatchObject([
        { reason: { category: "source_conflict" } },
      ]);
      const current = await fixture.client.get(keys.sources);
      expect(["first", "second"]).toContain(current);
      await expect(
        publishExtensionCatalog(fixture.client, keys, null, null, "obsolete", 60),
      ).rejects.toMatchObject({ category: "catalog_conflict" });
      await publishExtensionCatalog(fixture.client, keys, current, null, empty, 60);
      await expect(
        publishExtensionCatalog(fixture.client, keys, current, null, "obsolete", 60),
      ).rejects.toMatchObject({ category: "catalog_conflict" });
      expect(await fixture.client.get(keys.catalog)).toBe(empty);
    });

    it("rejects wrong-type source reads before invalidation and wrong-type catalog publication", async () => {
      await fixture.client.lpush(keys.sources, "synthetic");
      await fixture.client.set(keys.catalog, "old");
      await expect(readExtensionSnapshot(fixture.client, keys.sources)).rejects.toMatchObject({
        category: "source_storage_unavailable",
      });
      await expect(editExtensionSources(fixture.client, keys, null, "[]")).rejects.toMatchObject({
        category: "source_storage_unavailable",
      });
      expect(await fixture.client.lrange(keys.sources, 0, -1)).toEqual(["synthetic"]);
      expect(await fixture.client.get(keys.catalog)).toBe("old");
      await fixture.client.del(keys.sources, keys.catalog);
      await fixture.client.lpush(keys.catalog, "synthetic");
      await expect(
        publishExtensionCatalog(fixture.client, keys, null, null, empty, 60),
      ).rejects.toMatchObject({ category: "source_storage_unavailable" });
      expect(await fixture.client.lrange(keys.catalog, 0, -1)).toEqual(["synthetic"]);
    });

    it.each(["del", "set"])(
      "does not claim success when %s is denied inside the real edit script",
      async (denied) => {
        await fixture.client.set(keys.sources, "[]");
        await fixture.client.set(keys.catalog, "old");
        const username = `task6_${denied}`;
        await fixture.client.acl(
          "SETUSER",
          username,
          "reset",
          "on",
          "nopass",
          `~${fixture.prefix}*`,
          "+@all",
          `-${denied}`,
        );
        const restricted = new Redis({ ...fixture.options, username });
        try {
          await restricted.connect();
          await expect(editExtensionSources(restricted, keys, "[]", "next")).rejects.toMatchObject({
            category: "source_storage_unavailable",
          });
          expect(await fixture.client.get(keys.sources)).toBe("[]");
          // DEL failure prevents SET; SET failure occurs after safe cache loss.
          expect(await fixture.client.get(keys.catalog)).toBe(denied === "del" ? "old" : null);
        } finally {
          restricted.disconnect();
          await fixture.client.acl("DELUSER", username);
        }
      },
    );

    it("retains catalog bytes on a real publication command error", async () => {
      await fixture.client.set(keys.catalog, "old");
      await expect(
        publishExtensionCatalog(fixture.client, keys, null, "old", empty, 0),
      ).rejects.toMatchObject({ category: "source_storage_unavailable" });
      expect(await fixture.client.get(keys.catalog)).toBe("old");
    });

    it("exercises real store add/remove, successful empty and failed empty with synthetic providers", async () => {
      const extra = "https://extra.example.test/catalog.json";
      ports.fetch.mockImplementation(async (url) =>
        url === extra ? [{ id: "extra", name: "Extra" }] : [],
      );
      await addExtensionSource(extra, "Extra");
      expect(await getExtensionCatalog()).toEqual([
        { id: "extra", name: "Extra", trust: "community" },
      ]);
      await removeExtensionSource(extra);
      expect(await getExtensionCatalog()).toEqual([]);
      const denied =
        '{"entries":[{"id":"old","name":"Old"}],"killSwitch":{"removed":[["old","delisted"]],"critical":[["old",{"reason":"unsafe","maxVersion":"1.0.0"}]]}}';
      await fixture.client.set("extstore:catalog", denied);
      ports.fetch.mockRejectedValue(new Error("synthetic acquisition failure"));
      await expect(getExtensionCatalog(true)).rejects.toMatchObject({
        category: "catalog_acquisition_failed",
      });
      expect(await fixture.client.get("extstore:catalog")).toBe(denied);
      for (const malformed of [42, { extensions: "invalid" }, { critical: null }]) {
        ports.fetch.mockResolvedValue(malformed);
        await expect(getExtensionCatalog(true)).rejects.toMatchObject({
          category: "catalog_acquisition_failed",
        });
        expect(await fixture.client.get("extstore:catalog")).toBe(denied);
        await fixture.client.del("extstore:catalog");
        await expect(getExtensionCatalog(true)).rejects.toMatchObject({
          category: "catalog_acquisition_failed",
        });
        expect(await fixture.client.get("extstore:catalog")).toBeNull();
        await fixture.client.set("extstore:catalog", denied);
      }
      ports.fetch.mockResolvedValue([]);
      expect(await getExtensionCatalog(true)).toEqual([]);
      expect(await getExtensionCatalog()).toEqual([]);
    });
  },
);
