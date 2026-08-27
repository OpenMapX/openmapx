import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthProviderRequestError,
  exchangeMapillaryAuthorizationCode,
  fetchMapillaryUserInfo,
  fetchOsmUserDetails,
} from "./auth-provider-http";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stalledFetch() {
  let observedSignal: AbortSignal | undefined;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    observedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
        once: true,
      });
    });
  });
  return { spy, signal: () => observedSignal };
}

describe("auth provider HTTP", () => {
  it("aborts a stalled OSM user-info request at the application deadline", async () => {
    vi.useFakeTimers();
    const stalled = stalledFetch();

    const request = fetchOsmUserDetails(
      "https://api.openstreetmap.org/api/0.6/user/details.json",
      "token",
      {
        timeoutMs: 25,
      },
    );
    const rejected = expect(request).rejects.toBeInstanceOf(AuthProviderRequestError);
    await vi.advanceTimersByTimeAsync(26);

    await rejected;
    expect(stalled.signal()?.aborted).toBe(true);
  });

  it("aborts a stalled Mapillary token exchange at the application deadline", async () => {
    vi.useFakeTimers();
    const stalled = stalledFetch();

    const request = exchangeMapillaryAuthorizationCode(
      {
        code: "code",
        redirectUri: "https://openmapx.test/callback",
        clientId: "client",
        clientSecret: "secret",
      },
      { timeoutMs: 25 },
    );
    const rejected = expect(request).rejects.toBeInstanceOf(AuthProviderRequestError);
    await vi.advanceTimersByTimeAsync(26);

    await rejected;
    expect(stalled.signal()?.aborted).toBe(true);
  });

  it("sends the Mapillary exchange contract and validates its bounded response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ access_token: "map-token", expires_in: 3_600, token_type: "bearer" }),
      );

    await expect(
      exchangeMapillaryAuthorizationCode({
        code: "code",
        redirectUri: "https://openmapx.test/callback",
        clientId: "client",
        clientSecret: "secret",
      }),
    ).resolves.toEqual({ accessToken: "map-token", expiresInSeconds: 3_600, tokenType: "bearer" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://graph.mapillary.com/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "OAuth secret" }),
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "code",
          client_id: "client",
          redirect_uri: "https://openmapx.test/callback",
        }),
      }),
    );
  });

  it("maps malformed provider JSON to one stable redacted error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "user-without-name" }));

    const error = await fetchMapillaryUserInfo("map-token").catch((caught) => caught);

    expect(error).toBeInstanceOf(AuthProviderRequestError);
    expect(error).toMatchObject({ code: "auth-provider-request-failed", providerId: "mapillary" });
    expect(String(error)).not.toContain("user-without-name");
  });

  it("rejects a declared response larger than the auth-provider ceiling", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "999999" },
      }),
    );

    await expect(
      fetchOsmUserDetails("https://api.openstreetmap.org/user", "token"),
    ).rejects.toBeInstanceOf(AuthProviderRequestError);
  });
});
