import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "../index";

const url = process.env.OPENMAPX_TEST_VALKEY_URL;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe.skipIf(!url)("shared admission with actual Valkey Lua", () => {
  let redis: Redis;
  const namespace = `admission-test-${randomUUID()}`;
  const runtime = (integrationId: string, ns = namespace) =>
    createRedisUpstreamRuntime(redis as unknown as UpstreamRedisClient, {
      namespace: ns,
      integrationId,
      now: () => 0,
    });
  const identity = (key = randomUUID()) => ({ scope: "https://entur.test/client", key });
  const policy = { id: "trip", limit: 2, durationMs: 60_000, minIntervalMs: 0 };
  beforeAll(async () => {
    redis = new Redis(url as string, { enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    await new Promise<void>((resolve, reject) => {
      redis.once("ready", resolve);
      redis.once("error", reject);
    });
  });
  afterAll(async () => {
    if (!redis) return;
    const keys = await redis.keys(`upstream-shared:${namespace}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });

  it("shares concurrent admission across distinct integration runtimes and isolates namespace/client/family", async () => {
    const target = identity();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runtime(String(i)).admitSharedRequest({ ...target, policy }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    expect(results.filter((r) => !r.allowed)).toHaveLength(18);
    for (const request of [
      runtime("other", `${namespace}-other`).admitSharedRequest({ ...target, policy }),
      runtime("other").admitSharedRequest({
        ...target,
        scope: "https://entur.test/other-client",
        policy,
      }),
      runtime("other").admitSharedRequest({ ...target, key: "other-family", policy }),
    ])
      expect(await request).toEqual({ allowed: true, remaining: 1 });
  });

  it("starts the window at first admission rather than the wall-clock boundary, ignoring client clock", async () => {
    const subject = runtime("one");
    const target = identity();
    const window = { ...policy, limit: 1, durationMs: 1_000 };
    // Place the first request late in a server wall-clock second.
    while (true) {
      const [seconds, microseconds] = await redis.time();
      const phase = (Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000)) % 1_000;
      if (phase >= 800 && phase < 900) break;
      await pause(15);
    }
    expect(await subject.admitSharedRequest({ ...target, policy: window })).toEqual({
      allowed: true,
      remaining: 0,
    });
    await pause(250);
    expect(await subject.admitSharedRequest({ ...target, policy: window })).toMatchObject({
      allowed: false,
      reason: "quota",
    });
    await pause(800);
    expect(await subject.admitSharedRequest({ ...target, policy: window })).toEqual({
      allowed: true,
      remaining: 0,
    });
  });

  it("starts even a very long first window at server time", async () => {
    const subject = runtime("one");
    const target = identity();
    const long = { ...policy, limit: 1, durationMs: 3_000_000_000_000 };
    expect(await subject.admitSharedRequest({ ...target, policy: long })).toEqual({
      allowed: true,
      remaining: 0,
    });
    const denied = await subject.admitSharedRequest({ ...target, policy: long });
    expect(denied).toMatchObject({ allowed: false, reason: "quota" });
    if (!denied.allowed) expect(denied.retryAfterMs).toBeGreaterThan(2_999_999_999_000);
  });

  it("does not debit spacing rejection and keeps class windows separate", async () => {
    const subject = runtime("one");
    const target = identity();
    const spaced = { ...policy, minIntervalMs: 200 };
    expect(await subject.admitSharedRequest({ ...target, policy: spaced })).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(await subject.admitSharedRequest({ ...target, policy: spaced })).toMatchObject({
      allowed: false,
      reason: "spacing",
    });
    expect(
      await subject.admitSharedRequest({
        ...target,
        policy: { ...policy, id: "other", limit: 1 },
      }),
    ).toEqual({ allowed: true, remaining: 0 });
    await pause(220);
    expect(await subject.admitSharedRequest({ ...target, policy: spaced })).toEqual({
      allowed: true,
      remaining: 0,
    });
    expect(await subject.admitSharedRequest({ ...target, policy: spaced })).toMatchObject({
      allowed: false,
      reason: "quota",
    });
  });

  it("shares and maximizes cooldown across classes without inventing cooldown-only quota", async () => {
    const first = runtime("one");
    const second = runtime("two");
    const target = identity();
    expect(await first.admitSharedRequest(target)).toEqual({ allowed: true, remaining: null });
    await first.deferSharedRequests({ ...target, delayMs: 2_000 });
    await second.deferSharedRequests({ ...target, delayMs: 10 });
    const denied = await second.admitSharedRequest({ ...target, policy });
    expect(denied).toMatchObject({ allowed: false, reason: "cooldown" });
    if (!denied.allowed) expect(denied.retryAfterMs).toBeGreaterThan(1_000);
    await second.deferSharedRequests({ ...target, delayMs: 3_000 });
    const extended = await first.admitSharedRequest(target);
    expect(extended).toMatchObject({ allowed: false, reason: "cooldown" });
    if (!extended.allowed) expect(extended.retryAfterMs).toBeGreaterThan(2_500);
  });

  it("keeps long class TTL and shared quotas/cooldown through ordinary cache deletion", async () => {
    const subject = runtime("one");
    const target = identity();
    await subject.admitSharedRequest({ ...target, policy: { ...policy, limit: 1 } });
    await subject.admitSharedRequest({
      ...target,
      policy: { ...policy, id: "short", durationMs: 1 },
    });
    await subject.deferSharedRequests({ ...target, delayMs: 100 });
    await subject.write("ordinary", {}, { softMs: 100, hardMs: 100, staleIfErrorMs: 100 });
    await redis.set(`int:${namespace}:ordinary`, "ordinary");
    await redis.set(`cache:${namespace}:ordinary`, "ordinary");
    const disposable = [
      ...(await redis.keys(`upstream:${namespace}:*:cache:*`)),
      ...(await redis.keys(`int:${namespace}:*`)),
      ...(await redis.keys(`cache:${namespace}:*`)),
    ];
    if (disposable.length) await redis.del(...disposable);
    expect(await subject.admitSharedRequest(target)).toMatchObject({
      allowed: false,
      reason: "cooldown",
    });
    await pause(120);
    expect(
      await subject.admitSharedRequest({ ...target, policy: { ...policy, limit: 1 } }),
    ).toMatchObject({ allowed: false, reason: "quota" });
    const keys = await redis.keys(`upstream-shared:${namespace}:*`);
    const ttl = await Promise.all(keys.map((key) => redis.pttl(key)));
    expect(ttl.some((value) => value > 50_000)).toBe(true);
  });
});
