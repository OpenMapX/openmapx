// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authClient, initAuth } from "./client";

describe("OAuth Provider client support", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    initAuth({ baseURL: "http://localhost:3001" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries only the provider-signed authorization query into the sign-in request", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/oidc/sign-in?client_id=managed&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&sig=signed&ba_param=client_id&ba_param=ba_param&hostile=drop-me",
    );
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ user: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    initAuth({ baseURL: "http://localhost:3001" });

    await authClient.signIn.email({
      email: "ada@example.com",
      password: "fixture-password",
    });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.oauth_query).toBe(
      "client_id=managed&sig=signed&ba_param=client_id&ba_param=ba_param",
    );
    expect(body.oauth_query).not.toContain("redirect_uri");
    expect(body.oauth_query).not.toContain("hostile");
  });
});
