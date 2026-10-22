import type { UpstreamRuntime } from "@openmapx/integration-framework";
import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtpGraphQlAdapter } from "../../../../integrations/transit-dynamic-registry/otp-graphql";
import { OTP_PROFILES } from "../../../../integrations/transit-dynamic-registry/otp-profiles";
import type { RegistryEntry } from "../../../../integrations/transit-dynamic-registry/registry-types";
import { createHttpClient } from "../integration-clients";

afterEach(() => vi.unstubAllGlobals());
function fixture(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetch);
  const deferred = new Set<string>();
  const defer = vi.fn(async (input: { scope: string; key: string; delayMs: number }) => {
    deferred.add(input.scope + input.key);
  });
  const runtime = {
    admitSharedRequest: async (input: { scope: string; key: string }) =>
      deferred.has(input.scope + input.key)
        ? { allowed: false, reason: "cooldown", retryAfterMs: 37000 }
        : { allowed: true, remaining: null },
    deferSharedRequests: defer,
  } as unknown as UpstreamRuntime;
  function client(id: string) {
    const profile = OTP_PROFILES.find((p) => p.id === id);
    if (!profile) throw new Error("Missing fixture profile");
    const entry: RegistryEntry = {
      id: profile.id,
      slug: id,
      prefix: id + ":",
      name: id,
      protocol: "otpGraphQl",
      supportedLanguages: ["en"],
      options: { endpoint: profile.catalogEndpoint },
      coverage: { bbox: [-180, -90, 180, 90], tiers: [] },
    };
    const adapter = createOtpGraphQlAdapter({
      http: createHttpClient(createNoopLogger()),
      upstreamRuntime: runtime,
      signal: new AbortController().signal,
      isSourceAllowed: async () => true,
      digitransitApiKey: "fixture-key",
    });
    return () => adapter.searchByName?.(entry, "Public", 1);
  }
  return { fetch, defer, client };
}
describe("public OTP using actual host HTTP error boundaries", () => {
  it.each([
    ["text/plain", "slow down"],
    ["text/html", "<html>slow down</html>"],
    ["application/json", ""],
    ["application/json", "{bad"],
    ["application/json", "{}"],
  ])("records shared 429 before %s decoding", async (contentType, body) => {
    const f = fixture(
      () =>
        new Response(body, {
          status: 429,
          headers: { "content-type": contentType, "retry-after": "37" },
        }),
    );
    await expect(f.client("fi/digitransit-otp")()).rejects.toMatchObject({ kind: "quota" });
    expect(f.defer).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 37000 }));
    await expect(f.client("fi/helsinki-otp")()).rejects.toMatchObject({ kind: "quota" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("cancels a stalled, oversized error body without delaying shared cooldown", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const f = fixture(
      () =>
        new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel }), {
          status: 429,
          headers: {
            "content-type": "text/html",
            "content-length": String(5 * 1024 * 1024),
            "retry-after": "37",
          },
        }),
    );
    await expect(f.client("fi/digitransit-otp")()).rejects.toMatchObject({ kind: "quota" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.defer).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["text/plain", "{}"],
    ["application/json", "{bad"],
    ["application/json", JSON.stringify({ data: { stops: [{ bad: true }] } })],
  ])("rejects invalid success %s", async (contentType, body) => {
    const f = fixture(
      () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );
    await expect(f.client("fi/digitransit-otp")()).rejects.toThrow(/^OTP /);
    expect(f.defer).not.toHaveBeenCalled();
  });
  it("retains successful request JSON headers/body and strict generated decoding", async () => {
    const f = fixture(
      () =>
        new Response(JSON.stringify({ data: { stops: [] } }), {
          headers: { "content-type": "application/graphql-response+json" },
        }),
    );
    expect(await f.client("fi/digitransit-otp")()).toEqual([]);
    const init = f.fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init.headers).get("digitransit-subscription-key")).toBe("fixture-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: expect.stringContaining("DynamicSearch"),
      variables: { name: "Public" },
    });
  });
});

describe("metadata-only host error response safeguards", () => {
  it.each([
    { maxBytes: 0, successStatuses: [200] },
    { maxBytes: 100, successStatuses: [] },
    { maxBytes: 100, successStatuses: [429] },
  ])("rejects invalid bounds or success statuses before discard", async (options) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("error", { status: 429 })),
    );
    await expect(
      createHttpClient(createNoopLogger()).postText("https://fixture.test", "{}", {
        ...options,
        contentTypes: ["application/json"],
        discardErrorBody: true,
        redirect: "error",
      }),
    ).rejects.toThrow(/maxBytes|success statuses/);
  });
  it("retains bounded text error bodies by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("error", {
            status: 429,
            headers: { "content-type": "text/plain", "retry-after": "37" },
          }),
      ),
    );
    const response = await createHttpClient(createNoopLogger()).postText(
      "https://fixture.test",
      "{}",
      {
        maxBytes: 100,
        contentTypes: ["application/json"],
        responseHeaders: ["retry-after"],
        redirect: "error",
      },
    );
    expect(response).toEqual({ status: 429, headers: { "retry-after": "37" }, body: "error" });
  });
  it("retains the success byte ceiling when error bodies are discarded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("oversized", {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "9" },
          }),
      ),
    );
    await expect(
      createHttpClient(createNoopLogger()).postText("https://fixture.test", "{}", {
        maxBytes: 3,
        contentTypes: ["application/json"],
        discardErrorBody: true,
        redirect: "error",
      }),
    ).rejects.toThrow(/too large/);
  });
});
