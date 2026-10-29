import { createHash, randomUUID } from "node:crypto";
import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMbtaClient } from "../../../../../../integrations/transit-mbta/client";
import { apiWebStopControllerIndex } from "../../../../../../integrations/transit-mbta/generated/client";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "../index";

const url = process.env.OPENMAPX_TEST_VALKEY_URL;
describe.skipIf(!url)("MBTA clients with actual shared Valkey admission", () => {
  let redis: Redis;
  const namespace = `mbta-test-${randomUUID()}`;
  const generation = new AbortController();
  const runtime = (id: string) =>
    createRedisUpstreamRuntime(redis as unknown as UpstreamRedisClient, {
      namespace,
      integrationId: id,
    });
  function client(id: string, key: string, status = 200, headers: Record<string, string> = {}) {
    const http = fakeHttpClient(() => ({ status, headers, body: { data: [] } }));
    return {
      http,
      client: createMbtaClient({
        http,
        upstreamRuntime: runtime(id),
        apiKey: key,
        signal: generation.signal,
        isSourceAllowed: async () => true,
      }),
    };
  }
  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))
      throw new Error("MBTA qualification requires an explicit disposable loopback Valkey");
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    await redis.connect();
  });
  afterAll(async () => {
    generation.abort();
    if (redis?.status === "ready") {
      const keys = await redis.keys(`upstream-shared:${namespace}*`);
      if (keys.length) await redis.del(...keys);
    }
    redis?.disconnect();
  });
  it("counts one key across generations/integrations and isolates a different key", async () => {
    const key = `fixture-${randomUUID()}`;
    const identity = {
      scope: "https://api-v3.mbta.com",
      key: createHash("sha256").update(key).digest("hex"),
    };
    // Fill the same default counter through real Lua; omit spacing only for this bounded setup.
    const decisions = await Promise.all(
      Array.from({ length: 999 }, () =>
        runtime("seed").admitSharedRequest({
          ...identity,
          policy: {
            id: "mbta-registered-default",
            limit: 1000,
            durationMs: 60000,
            minIntervalMs: 0,
          },
        }),
      ),
    );
    expect(decisions.every((value) => value.allowed)).toBe(true);
    const a = client("generation-a", key);
    const b = client("generation-b", key);
    const other = client("generation-c", `${key}-other`);
    await apiWebStopControllerIndex({}, { client: a.client });
    await expect(apiWebStopControllerIndex({}, { client: b.client })).rejects.toMatchObject({
      kind: "quota",
    });
    await apiWebStopControllerIndex({}, { client: other.client });
    expect(a.http.calls).toHaveLength(1);
    expect(b.http.calls).toHaveLength(0);
    expect(other.http.calls).toHaveLength(1);
  });
  it("propagates provider cooldown to another instance before network", async () => {
    const key = `fixture-${randomUUID()}`;
    const first = client("before", key, 429, {
      "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 20),
    });
    await expect(apiWebStopControllerIndex({}, { client: first.client })).rejects.toMatchObject({
      kind: "quota",
    });
    const second = client("after", key);
    await expect(apiWebStopControllerIndex({}, { client: second.client })).rejects.toMatchObject({
      kind: "quota",
    });
    expect(second.http.calls).toHaveLength(0);
    const distinct = client("other", `${key}-other`);
    await apiWebStopControllerIndex({}, { client: distinct.client });
    expect(distinct.http.calls).toHaveLength(1);
  });
});
