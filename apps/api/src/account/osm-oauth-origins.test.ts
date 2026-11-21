import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: [] as { config: Record<string, unknown>[] }[] }));
vi.mock("better-auth/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth/plugins")>();
  return {
    ...actual,
    genericOAuth: (options: Parameters<typeof actual.genericOAuth>[0]) => {
      captured.options.push(options as never);
      return actual.genericOAuth(options);
    },
  };
});

const DEV = "https://master.apis.dev.openstreetmap.org";

/**
 * A deployment that points OSM at the development instance must reach that
 * instance for sign-in, tokens and user details too; a leftover production
 * URL in the sign-in provider would silently mix the two.
 */
describe("OpenStreetMap sign-in provider", () => {
  let provider: Record<string, unknown>;
  beforeAll(async () => {
    vi.stubEnv("OSM_API_URL", DEV);
    vi.stubEnv("OSM_WEB_URL", DEV);
    vi.stubEnv("OSM_DISCOVERY_URL", `${DEV}/.well-known/openid-configuration`);
    (await import("../utils/osm-config")).resetOsmConfigForTests();
    await import("../auth");
    const config = captured.options.flatMap((options) => options.config);
    provider = config.find((entry) => entry.providerId === "openstreetmap") ?? {};
  }, 30_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    (await import("../utils/osm-config")).resetOsmConfigForTests();
  });

  it("discovers, authorizes and exchanges tokens at the configured OSM origin", () => {
    expect(provider).toMatchObject({
      discoveryUrl: `${DEV}/.well-known/openid-configuration`,
      authorizationUrl: `${DEV}/oauth2/authorize`,
      tokenUrl: `${DEV}/oauth2/token`,
    });
  });

  it("reads the signed-in user's details from the configured OSM API", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ user: { id: 7, display_name: "mapper" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const getUserInfo = provider.getUserInfo as (tokens: { accessToken: string }) => Promise<{
      id: string;
    }>;

    await expect(getUserInfo({ accessToken: "synthetic-token" })).resolves.toMatchObject({
      id: "7",
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${DEV}/api/0.6/user/details.json`);
  });
});
