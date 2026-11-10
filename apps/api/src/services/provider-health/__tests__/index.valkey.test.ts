import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDisposableValkeyFixture } from "../../__tests__/support/disposable-valkey-fixture";
import { ProviderHealth } from "../index.js";

// Positive mode executes the actual registered Lua; no provider URLs or operator stores are consulted.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "ProviderHealth on pinned disposable Valkey",
  () => {
    let fixture: Awaited<ReturnType<typeof createDisposableValkeyFixture>>;
    beforeAll(async () => {
      fixture = await createDisposableValkeyFixture();
    }, 60_000);
    afterAll(async () => {
      await fixture?.stop();
    }, 30_000);
    beforeEach(async () => {
      await fixture.client.flushdb();
    });

    it("degrades at two consecutive counted failures and at a 25% window rate", async () => {
      const health = await ProviderHealth.init({ redis: fixture.client });
      await health.recordFailure("consecutive", 10, "timeout");
      expect((await health.getSnapshot("consecutive")).state).toBe("healthy");
      await health.recordFailure("consecutive", 10, "connection");
      expect((await health.getSnapshot("consecutive")).state).toBe("degraded");

      await health.recordSuccess("rate", 10);
      await health.recordSuccess("rate", 10);
      await health.recordSuccess("rate", 10);
      await health.recordFailure("rate", 10, "invalid_payload");
      expect((await health.getSnapshot("rate")).state).toBe("degraded");
    });

    it("opens above 50% with enough samples or at five consecutive failures", async () => {
      const health = await ProviderHealth.init({ redis: fixture.client, minSampleSize: 4 });
      await health.recordSuccess("rate", 10);
      await health.recordFailure("rate", 10, "timeout");
      await health.recordFailure("rate", 10, "timeout");
      await health.recordFailure("rate", 10, "timeout");
      expect((await health.getSnapshot("rate")).state).toBe("open");

      // Keep the rate rule below its minimum sample size so only the streak can open this provider.
      const streak = await ProviderHealth.init({ redis: fixture.client, minSampleSize: 10 });
      for (let index = 0; index < 4; index++)
        await streak.recordFailure("streak", 10, "upstream_5xx");
      expect((await streak.getSnapshot("streak")).state).toBe("degraded");
      await streak.recordFailure("streak", 10, "upstream_5xx");
      expect((await streak.getSnapshot("streak")).state).toBe("open");
    });

    it("excludes valid empty, policy, input and quota from circuit failures", async () => {
      const health = await ProviderHealth.init({ redis: fixture.client });
      await health.recordSuccess("safe", 10);
      for (const outcome of ["valid_empty", "policy", "input", "quota"] as const) {
        await health.recordFailure("safe", 10, outcome, "operator detail");
      }
      const snapshot = await health.getSnapshot("safe");
      expect(snapshot).toMatchObject({
        state: "healthy",
        successCount: 1,
        failureCount: 4,
        countedFailureCount: 0,
      });
      expect(snapshot.lastOperatorMessage).toBe("operator detail");
    });

    it("retains a provider's first non-counted outcome without an invalid-record fallback", async () => {
      const health = await ProviderHealth.init({ redis: fixture.client });
      await health.recordFailure("fresh", 10, "valid_empty", "no departures");
      expect(await health.getSnapshot("fresh")).toMatchObject({
        state: "healthy",
        failureCount: 1,
        countedFailureCount: 0,
        lastOperatorMessage: "no departures",
      });
    });

    it("leaves state, the last error and a half-open lease untouched by a cancellation", async () => {
      let now = 1_700_000_000_000;
      const health = await ProviderHealth.init({
        redis: fixture.client,
        now: () => now,
        cooldownsMs: [100],
      });
      for (let index = 0; index < 5; index++)
        await health.recordFailure("probe", 10, "auth", "credential rejected");
      now += 101;
      expect(await health.isHealthy("probe")).toBe(true);
      const before = await fixture.client.get("provider:health:probe");

      await health.recordFailure("probe", 900, "caller_cancelled", "provider call cancelled");

      expect(await fixture.client.get("provider:health:probe")).toBe(before);
      expect(await fixture.client.exists("provider:health-probe:probe")).toBe(1);
      expect(await health.isHealthy("probe")).toBe(false);
    });

    it("leases one half-open probe, escalates cooldowns, and recovers after three successes", async () => {
      let now = 1_700_000_000_000;
      const redis = fixture.client;
      const options = {
        redis,
        now: () => now,
        cooldownsMs: [100, 200, 400, 800, 1_600],
      };
      const first = await ProviderHealth.init(options);
      const second = await ProviderHealth.init(options);
      for (let index = 0; index < 5; index++) await first.recordFailure("acme", 10, "timeout");
      const initial = await first.getSnapshot("acme");
      expect(Date.parse(initial.retryAt as string) - now).toBe(100);

      now += 101;
      expect(await first.isHealthy("acme")).toBe(true);
      expect(await second.isHealthy("acme")).toBe(false);
      await first.recordFailure("acme", 10, "timeout");
      const reopened = await first.getSnapshot("acme");
      expect(Date.parse(reopened.retryAt as string) - now).toBe(200);

      now += 201;
      expect(await first.isHealthy("acme")).toBe(true);
      await first.recordSuccess("acme", 20);
      expect((await first.getSnapshot("acme")).state).toBe("degraded");
      await first.recordSuccess("acme", 20);
      await first.recordSuccess("acme", 20);
      expect((await first.getSnapshot("acme")).state).toBe("healthy");
    });
  },
);
