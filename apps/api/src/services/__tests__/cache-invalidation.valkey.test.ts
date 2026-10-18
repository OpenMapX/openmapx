import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CacheInvalidation } from "../cache-invalidation";

// Explicit opt-in for a disposable Valkey instance; ordinary unit tests use
// injected Redis boundaries and never connect to a development/production store.
const url = process.env.OPENMAPX_TEST_VALKEY_URL;
describe.skipIf(!url)("cache invalidation with real Valkey", () => {
  let redis: Redis;
  let first: CacheInvalidation;
  let second: CacheInvalidation;
  const key = "int:cache-review:value";

  beforeAll(async () => {
    redis = new Redis(url as string, { enableOfflineQueue: false });
    await new Promise<void>((resolve, reject) => {
      redis.once("ready", resolve);
      redis.once("error", reject);
    });
    first = new CacheInvalidation(redis);
    second = new CacheInvalidation(redis);
    await first.start();
    await second.start();
  });
  afterAll(async () => {
    await Promise.all([first?.stop(), second?.stop()]);
    await redis?.del(key);
    redis?.disconnect();
  });

  it("fences old and overlapping fills atomically while allowing post-clear data", async () => {
    const old = await first.captureEpoch();
    await first.writeIfCurrent(key, "initial", 60, old);
    expect(await redis.get(key)).toBe("initial");
    await second.invalidate(["int:cache-review:*"], async () => {
      await redis.unlink(key);
      await first.writeIfCurrent(key, "during-clear", 60, await first.captureEpoch());
      expect(await redis.get(key)).toBeNull();
    });
    await first.writeIfCurrent(key, "old", 60, old);
    expect(await redis.get(key)).toBeNull();
    await first.writeIfCurrent(key, "fresh", 60, await first.captureEpoch());
    expect(await redis.get(key)).toBe("fresh");
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("broadcasts scoped clears to another subscribed worker", async () => {
    const events: boolean[] = [];
    const unsubscribe = first.subscribe("int:cache-review:", ({ available }) =>
      events.push(available),
    );
    await vi.waitFor(() => expect(events.at(-1)).toBe(true));
    const count = events.length;
    await second.invalidate(["int:unrelated:*"], async () => undefined);
    expect(events.length).toBe(count);
    await second.invalidate(["int:cache-review:*"], async () => undefined);
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(count + 2));
    unsubscribe();
  });

  it("preserves direct persistent writes while refusing them during a clear", async () => {
    await first.writeIfCurrent(key, "persistent", 0, await first.captureEpoch());
    expect(await redis.get(key)).toBe("persistent");
    expect(await redis.ttl(key)).toBe(-1);
    await second.invalidate(["int:cache-review:*"], async () => {
      await redis.unlink(key);
      await first.writeIfCurrent(key, "blocked", 0, await first.captureEpoch());
      expect(await redis.get(key)).toBeNull();
    });
  });

  it("disables and resynchronizes local caching after a real subscriber reconnect", async () => {
    const connectionName = `openmapx-cache-review-${crypto.randomUUID()}`;
    const client = new Redis(url as string, {
      enableOfflineQueue: false,
      connectionName,
      retryStrategy: () => 25,
    });
    const worker = new CacheInvalidation(client);
    const events: boolean[] = [];
    const unsubscribe = worker.subscribe("int:cache-review:", ({ available }) =>
      events.push(available),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("ready", resolve);
        client.once("error", reject);
      });
      await worker.start();
      await vi.waitFor(() => expect(events.at(-1)).toBe(true));
      const clients = String(await redis.client("LIST", "TYPE", "PUBSUB"));
      const subscriber = clients
        .split("\n")
        .find((line) => line.includes(`name=${connectionName} `));
      const id = subscriber?.match(/(?:^| )id=(\d+)/)?.[1];
      expect(id).toBeDefined();
      const count = events.length;
      await redis.client("KILL", "ID", id as string);
      await vi.waitFor(() => expect(events.slice(count)).toContain(false));
      await vi.waitFor(() => expect(events.at(-1)).toBe(true));
      expect(events.slice(count)).toContain(true);
      const restored = events.length;
      await second.invalidate(["int:cache-review:*"], async () => undefined);
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(restored + 2));
    } finally {
      unsubscribe();
      await worker.stop();
      client.disconnect();
    }
  });

  it("keeps shared fills blocked until concurrent clears both finish", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = first.invalidate(["int:cache-review:*"], async () => {
      await redis.unlink(key);
      started.resolve();
      await release.promise;
    });
    await started.promise;
    try {
      await second.invalidate(["int:cache-review:*"], async () => undefined);
      await second.writeIfCurrent(key, "blocked", 60, await second.captureEpoch());
      expect(await redis.get(key)).toBeNull();
    } finally {
      release.resolve();
      await pending;
    }
    await second.writeIfCurrent(key, "after-both", 60, await second.captureEpoch());
    expect(await redis.get(key)).toBe("after-both");
  });
});
