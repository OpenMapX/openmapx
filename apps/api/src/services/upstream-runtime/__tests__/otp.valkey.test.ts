import { randomUUID } from "node:crypto";
import { createNoopLogger, fakeHttpClient } from "@openmapx/integration-framework/testing";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOtpGraphQlAdapter } from "../../../../../../integrations/transit-dynamic-registry/otp-graphql";
import { OTP_PROFILES } from "../../../../../../integrations/transit-dynamic-registry/otp-profiles";
import type { RegistryEntry } from "../../../../../../integrations/transit-dynamic-registry/registry-types";
import { createHttpClient } from "../../../integration-clients";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "../index";

const url = process.env.OPENMAPX_TEST_VALKEY_URL;
describe.skipIf(!url)("dynamic OTP shared cooldown with actual Valkey", () => {
  let redis: Redis;
  const namespace = "otp-test-" + randomUUID();
  const generation = new AbortController();
  function client(
    id: string,
    key: string,
    profileId: string,
    status = 200,
    headers: Record<string, string> = {},
  ) {
    const profile = OTP_PROFILES.find((p) => p.id === profileId);
    if (!profile) throw new Error("Missing test profile");
    const entry: RegistryEntry = {
      id: profile.id,
      name: profile.id,
      slug: id,
      prefix: id + ":",
      protocol: "otpGraphQl",
      supportedLanguages: ["en"],
      options: { endpoint: profile.catalogEndpoint },
      coverage: { bbox: [-180, -90, 180, 90], tiers: [] },
    };
    const http = fakeHttpClient(() => ({
      status,
      headers,
      body: JSON.stringify({ data: { stops: [] } }),
    }));
    const adapter = createOtpGraphQlAdapter({
      http,
      upstreamRuntime: createRedisUpstreamRuntime(redis as unknown as UpstreamRedisClient, {
        namespace,
        integrationId: id,
      }),
      digitransitApiKey: key,
      signal: generation.signal,
      isSourceAllowed: async () => true,
    });
    return { http, run: () => adapter.searchByName?.(entry, "Public fixture", 1) };
  }
  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))
      throw new Error("OTP qualification requires explicit disposable loopback Valkey");
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
  it("shares provider cooldown across setup generations and regions while isolating different credentials", async () => {
    const key = randomUUID();
    const first = client("first", key, "fi/digitransit-otp", 429, { "retry-after": "30" });
    await expect(first.run()).rejects.toMatchObject({ kind: "quota" });
    for (const profile of OTP_PROFILES.filter((p) => p.keyed)) {
      const next = client("next-" + profile.id, key, profile.id);
      await expect(next.run()).rejects.toMatchObject({ kind: "quota" });
      expect(next.http.calls).toHaveLength(0);
    }
    const other = client("other", randomUUID(), "fi/helsinki-otp");
    expect(await other.run()).toEqual([]);
    expect(other.http.calls).toHaveLength(1);
  });
  it("shares anonymous-authority cooldown without adding an invented numeric quota", async () => {
    const first = client("a", "", "ee/peatus-otp", 429, { "retry-after": "30" });
    await expect(first.run()).rejects.toMatchObject({ kind: "quota" });
    const second = client("b", "", "ee/peatus-otp");
    await expect(second.run()).rejects.toMatchObject({ kind: "quota" });
    expect(second.http.calls).toHaveLength(0);
    const different = client("c", "", "it/torino-otp");
    expect(await different.run()).toEqual([]);
    expect(different.http.calls).toHaveLength(1);
  });
  it("records a non-JSON actual host response in Valkey before another regional client", async () => {
    const key = randomUUID();
    const first = client("actual-host", key, "fi/digitransit-otp");
    const fetch = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "content-type": "text/plain", "retry-after": "37" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const real = createHttpClient(createNoopLogger());
    const post = vi.spyOn(first.http, "postText").mockImplementation(real.postText);
    try {
      await expect(first.run()).rejects.toMatchObject({ kind: "quota" });
      const second = client("after-actual-host", key, "fi/waltti-otp");
      await expect(second.run()).rejects.toMatchObject({ kind: "quota" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(second.http.calls).toHaveLength(0);
    } finally {
      post.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
