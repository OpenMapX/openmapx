import { Writable } from "node:stream";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "discovery-test-secret-at-least-thirty-two-chars");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OpenMapX OIDC discovery", () => {
  it("logs only bounded metadata when the auth handler throws credential-bearing data", async () => {
    const { authRoute } = await import("../auth");
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const app = Fastify({ loggerInstance: pino(stream) });
    await app.register(authRoute, {
      authUiOrigin: "http://localhost:3000",
      authHandler: async () => {
        throw Object.assign(new Error("failed authorization-code-sentinel"), {
          access_token: "access-token-sentinel",
          response: { body: "refresh-token-sentinel" },
          config: { headers: { authorization: "Bearer access-token-sentinel" } },
        });
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/callback/managed-dawarich?code=authorization-code-sentinel",
      headers: { host: "localhost:3001" },
    });
    await app.close();

    const serializedLogs = chunks.join("");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal authentication error" });
    expect(serializedLogs).toContain("auth_handler_failed");
    expect(serializedLogs).not.toMatch(
      /authorization-code-sentinel|access-token-sentinel|refresh-token-sentinel|Bearer/,
    );
  });

  it("forwards OAuth form posts verbatim through the production Fastify bridge", async () => {
    const { authRoute } = await import("../auth");
    let received: Request | undefined;
    const app = Fastify({ logger: false });
    await app.register(authRoute, {
      authUiOrigin: "http://localhost:3000",
      authHandler: async (request) => {
        received = request;
        return Response.json({ ok: true });
      },
    });

    const body =
      "grant_type=authorization_code&code=one%2Btwo&redirect_uri=https%3A%2F%2Ftimeline.example%2Fcallback";
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        host: "localhost:3001",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        authorization: "Basic Y2xpZW50OnNlY3JldA==",
      },
      body,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(received).toBeDefined();
    expect(received?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded; charset=UTF-8",
    );
    expect(received?.headers.get("authorization")).toBe("Basic Y2xpZW50OnNlY3JldA==");
    await expect(received?.text()).resolves.toBe(body);
  });

  it("rejects client secrets in OAuth form bodies before they reach Better Auth", async () => {
    const { authRoute } = await import("../auth");
    const authHandler = vi.fn(async () => Response.json({ access_token: "must-not-run" }));
    const app = Fastify({ logger: false });
    await app.register(authRoute, {
      authHandler,
      authUiOrigin: "http://localhost:3000",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        host: "localhost:3001",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=authorization_code&client_id=managed&client_secret=do-not-log&code=test",
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
    expect(response.body).not.toContain("do-not-log");
    expect(authHandler).not.toHaveBeenCalled();
  });

  it("redirects fixed interaction pages to the configured web origin without a query-controlled host", async () => {
    const { authRoute } = await import("../auth");
    const app = Fastify({ logger: false });
    await app.register(authRoute, {
      authHandler: async () => new Response(null, { status: 404 }),
      authUiOrigin: "http://localhost:3000",
    });

    for (const page of ["sign-in", "consent"]) {
      const response = await app.inject({
        method: "GET",
        url: `/auth/oidc/${page}?sig=signed&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal`,
        headers: { host: "evil.example" },
      });
      expect(response.statusCode).toBe(302);
      const target = new URL(response.headers.location ?? "");
      expect(target.origin).toBe("http://localhost:3000");
      expect(target.pathname).toBe(`/auth/oidc/${page}`);
      expect(target.searchParams.get("sig")).toBe("signed");
      expect(target.searchParams.get("redirect_uri")).toBe("https://evil.example/steal");
    }
    await app.close();
  });

  it("serves issuer metadata through the production Fastify auth bridge", async () => {
    const [{ auth }, { authRoute }] = await Promise.all([import("../../auth"), import("../auth")]);
    const app = Fastify({ logger: false });
    await app.register(authRoute, {
      authHandler: auth.handler,
      authUiOrigin: "http://localhost:3000",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/.well-known/openid-configuration",
      headers: { host: "localhost:3001" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const metadata = response.json();
    expect(metadata.issuer).toBe("http://localhost:3001/api/auth");
    expect(metadata.authorization_endpoint).toBe("http://localhost:3001/api/auth/oauth2/authorize");
    expect(metadata.token_endpoint).toBe("http://localhost:3001/api/auth/oauth2/token");
    expect(metadata.userinfo_endpoint).toBe("http://localhost:3001/api/auth/oauth2/userinfo");
    expect(metadata.response_types_supported).toContain("code");
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining(["openid", "profile", "email"]),
    );
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.code_challenge_methods_supported).not.toContain("plain");
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);
    expect(metadata.introspection_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);
    expect(metadata.revocation_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);
  });
});
