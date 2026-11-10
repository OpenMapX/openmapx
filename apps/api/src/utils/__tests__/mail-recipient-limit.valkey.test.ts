import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDisposableValkeyFixture } from "../../services/__tests__/support/disposable-valkey-fixture";
import { createMailRecipientLimit, mailRecipientKey } from "../mail-recipient-limit";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "per-recipient mail limit on owned disposable Valkey",
  () => {
    let fixture: Awaited<ReturnType<typeof createDisposableValkeyFixture>>;
    let redis: Redis;

    beforeAll(async () => {
      fixture = await createDisposableValkeyFixture();
      redis = new Redis({ ...fixture.options, lazyConnect: false });
      await new Promise<void>((resolve, reject) => {
        redis.once("ready", resolve);
        redis.once("error", reject);
      });
    }, 45_000);
    afterAll(async () => {
      try {
        redis?.disconnect();
      } finally {
        await fixture?.stop();
      }
    });

    it("counts atomically across concurrent senders and keeps the first window", async () => {
      const limit = createMailRecipientLimit({ store: redis, limit: 3 });
      const address = "concurrent@example.test";
      const results = await Promise.all(Array.from({ length: 8 }, () => limit.admit(address)));
      expect(results.filter(Boolean)).toHaveLength(3);
      const key = mailRecipientKey(address);
      expect(await redis.get(key)).toBe("8");
      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(3_590_000);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
      await redis.pexpire(key, 1_000);
      expect(await limit.admit(address)).toBe(false);
      expect(await redis.pttl(key)).toBeLessThanOrEqual(1_000);
    });

    it("admits the address again once its window expires", async () => {
      const limit = createMailRecipientLimit({ store: redis, limit: 1, windowMs: 200 });
      const address = "expiring@example.test";
      expect(await limit.admit(address)).toBe(true);
      expect(await limit.admit(address)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await limit.admit(address)).toBe(true);
    });
  },
);
