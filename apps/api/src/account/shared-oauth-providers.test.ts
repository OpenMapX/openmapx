import { afterEach, describe, expect, it, vi } from "vitest";
import { shareGenericOAuthProviders } from "./shared-oauth-providers";

const discoveryUrl = "https://provider.example.test/.well-known/openid-configuration";
const document = {
  issuer: "https://provider.example.test",
  jwks_uri: "https://provider.example.test/keys",
  id_token_signing_alg_values_supported: ["RS256"],
};
const endpoints = {
  providerId: "fixture",
  authorizationUrl: "https://provider.example.test/authorize",
  tokenUrl: "https://provider.example.test/token",
  clientId: "client",
  clientSecret: "secret",
};
const options = { config: [{ ...endpoints, discoveryUrl }] };
type Plugin = ReturnType<typeof shareGenericOAuthProviders>;
const context = () =>
  ({
    socialProviders: [],
    baseURL: "http://localhost:3001",
    logger: { error: () => {}, warn: () => {} },
  }) as unknown as Parameters<Plugin["init"]>[0];
const issuerOf = async (plugin: Plugin) =>
  (await plugin.init(context())).context.socialProviders.find((p) => p.id === "fixture")?.issuer;
const answer = (status = 200) =>
  new Response(JSON.stringify(status === 200 ? document : {}), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("shared generic OAuth providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("discovers once for every auth instance", async () => {
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    const plugin = shareGenericOAuthProviders(options);
    const issuers = await Promise.all(Array.from({ length: 5 }, () => issuerOf(plugin)));
    expect(issuers).toEqual(Array(5).fill(document.issuer));
    expect(await issuerOf(plugin)).toBe(document.issuer);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a slow discovery and adopts its late answer", async () => {
    let release: (response: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetch);
    const plugin = shareGenericOAuthProviders(options, { discoveryTimeoutMs: 20 });
    const built = await plugin.init(context());
    const provider = built.context.socialProviders.find((p) => p.id === "fixture");
    expect(provider?.issuer).toBeUndefined();
    expect(provider?.idToken).toBeUndefined();
    expect(await issuerOf(plugin)).toBeUndefined();
    release(answer());
    await vi.waitFor(async () => expect(await issuerOf(plugin)).toBe(document.issuer));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a refused discovery in the background after the pause", async () => {
    let status = 429,
      time = 0;
    const fetch = vi.fn(async () => answer(status));
    vi.stubGlobal("fetch", fetch);
    const plugin = shareGenericOAuthProviders(options, { retryMs: 1000, now: () => time });
    expect(await issuerOf(plugin)).toBeUndefined();
    const attempts = fetch.mock.calls.length;
    expect(await issuerOf(plugin)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(attempts);
    status = 200;
    time = 1000;
    expect(await issuerOf(plugin)).toBeUndefined();
    await vi.waitFor(async () => expect(await issuerOf(plugin)).toBe(document.issuer));
    expect(fetch).toHaveBeenCalledTimes(attempts + 1);
  });

  it("makes no request for providers without a discovery document", async () => {
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetch);
    const plugin = shareGenericOAuthProviders({ config: [endpoints] });
    const built = await plugin.init(context());
    expect(built.context.socialProviders.map((p) => p.id)).toEqual(["fixture"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
