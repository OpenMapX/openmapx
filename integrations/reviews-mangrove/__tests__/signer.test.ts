import { generateKeyPairSync } from "node:crypto";
import type { RouteHandler, UpstreamRuntime } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

const ORIGIN = "https://signer.mangrove.reviews";
const CONFIG = {
  signerClientId: "registered-client",
  signerRedirectUri: "https://maps.test/auth/mangrove",
};
const MULTILINE_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
const PEM = MULTILINE_PEM.replace(/\n/g, "");
const ACCOUNT = {
  reviewer_id: "reviewer-1",
  public_key: PEM,
  did: "did:plc:example",
  account_name: "Ada",
  provider: "osm",
  recovery_key: "omit-this",
  session_token: "fixture-token",
};
const REVIEW = { sub: "geo:50,6?q=Place&u=50", rating: 80, metadata: { nickname: "Ada" } };
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJodHRwczovL2V4YW1wbGUuY29tIn0.c2lnbmF0dXJl";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(config: Record<string, unknown> = CONFIG) {
  let response: unknown = ACCOUNT;
  const http = fakeHttpClient(async () => {
    const value = await response;
    if (value && typeof value === "object" && "status" in value && "body" in value) {
      return { ...value, body: value.body == null ? "" : JSON.stringify(value.body) };
    }
    return JSON.stringify(value);
  });
  const ctx = createMockIntegrationContext({ id: "reviews-mangrove", config, http });
  const admission = vi.fn(
    async (_input: Parameters<NonNullable<UpstreamRuntime["admitSharedRequest"]>>[0]) => ({
      allowed: true,
      remaining: null,
    }),
  );
  Object.assign(ctx, {
    upstreamRuntime: { admitSharedRequest: admission } as unknown as UpstreamRuntime,
  });
  const shutdown: (() => Promise<void>)[] = [];
  ctx.onShutdown = (fn) => {
    shutdown.push(fn);
  };
  const sources = new Set<string>();
  const integrations = new Set<string>();
  ctx.getDisallowedSourceIds = async () => sources;
  ctx.getDisallowedIntegrationIds = async () => integrations;
  const log = vi.spyOn(ctx.log, "error");
  setup(ctx);
  async function call(
    path: string,
    body: unknown = { sessionToken: "fixture-token" },
    extras: Partial<Parameters<RouteHandler>[0]> = {},
  ) {
    const route = ctx.registered.routes.find((r) => r.path === `/signer/${path}`);
    expect(route, `Missing signer route ${path}`).toBeDefined();
    let status = 200;
    let result: unknown;
    const headers: Record<string, string> = {};
    if (!route) throw new Error("Signer route missing");
    await route.handler(
      { query: {}, params: {}, headers: {}, body, userId: "owner", ...extras },
      {
        send: (data) => {
          result = data;
        },
        status: (code) => {
          status = code;
          return {
            send: (data) => {
              result = data;
            },
          };
        },
        header: (name, value) => {
          headers[name.toLowerCase()] = value;
        },
        type: () => {},
      },
    );
    expect(headers["cache-control"]).toBe("no-store");
    return { status, body: result };
  }
  return {
    ctx,
    http,
    admission,
    sources,
    integrations,
    shutdown,
    log,
    call,
    respond: (value: unknown) => {
      response = value;
    },
  };
}

describe("Mangrove signer through integration setup", () => {
  it("registers only authenticated expensive fixed signer routes and keeps the review provider", async () => {
    const f = fixture();
    expect(
      f.ctx.registered.routes.map(({ method, path, options }) => ({ method, path, options })),
    ).toEqual([
      {
        method: "GET",
        path: "/signer/config",
        options: { requireAuth: true, rateLimitTier: "expensive" },
      },
      {
        method: "POST",
        path: "/signer/account",
        options: { requireAuth: true, rateLimitTier: "expensive" },
      },
      {
        method: "POST",
        path: "/signer/sign",
        options: { requireAuth: true, rateLimitTier: "expensive" },
      },
      {
        method: "POST",
        path: "/signer/revoke",
        options: { requireAuth: true, rateLimitTier: "expensive" },
      },
    ]);
    expect(f.ctx.registered.review).toHaveLength(1);
    expect(await f.call("config")).toEqual({
      status: 200,
      body: {
        configured: true,
        clientId: "registered-client",
        redirectUri: CONFIG.signerRedirectUri,
        signerUrl: ORIGIN,
        accountUrl: "https://mangrove.reviews/account",
      },
    });
    expect(f.http.calls).toHaveLength(0);
  });

  it.each([
    {},
    { ...CONFIG, signerClientId: "" },
    { ...CONFIG, signerClientId: "bad\nvalue" },
    { ...CONFIG, signerRedirectUri: "not a URL" },
    { ...CONFIG, signerRedirectUri: "https://maps.test/wrong" },
    { ...CONFIG, signerRedirectUri: "http://maps.test/auth/mangrove" },
    { ...CONFIG, signerRedirectUri: "https://user:pass@maps.test/auth/mangrove" },
    { ...CONFIG, signerRedirectUri: "https://maps.test/auth/mangrove?redirect=elsewhere" },
    { ...CONFIG, signerRedirectUri: "https://maps.test/auth/mangrove#fragment" },
  ])("starts safely with invalid registration %j", async (config) => {
    const f = fixture(config);
    expect(await f.call("config")).toEqual({ status: 200, body: { configured: false } });
    expect((await f.call("account")).status).toBe(503);
    expect(f.http.calls).toHaveLength(0);
  });

  it.each([
    "http://localhost:3000/auth/mangrove",
    "http://127.0.0.1:3000/auth/mangrove",
    "http://[::1]:3000/auth/mangrove",
  ])("permits exact loopback development callback %s", async (signerRedirectUri) => {
    expect((await fixture({ ...CONFIG, signerRedirectUri }).call("config")).body).toMatchObject({
      configured: true,
      redirectUri: signerRedirectUri,
    });
  });

  it("maps the official account wire shape and strips unrelated upstream fields", async () => {
    const f = fixture();
    expect(
      await f.call("account", { sessionToken: "fixture-token", expectedUserId: "owner" }),
    ).toEqual({
      status: 200,
      body: {
        reviewerId: "reviewer-1",
        publicPem: PEM,
        did: "did:plc:example",
        accountName: "Ada",
        provider: "osm",
      },
    });
    expect(f.http.calls[0]).toMatchObject({
      method: "postText",
      url: `${ORIGIN}/account`,
      body: JSON.stringify({ session_token: "fixture-token" }),
      options: { redirect: "error", maxBytes: 131072, timeoutMs: 10000 },
    });
    expect(f.http.calls[0].options).not.toHaveProperty("cache");
    expect(f.admission.mock.calls[0][0]).toMatchObject({
      scope: "mangrove-signer",
      key: `${ORIGIN}|registered-client`,
    });
    expect(f.admission.mock.calls[0][0]).not.toHaveProperty("policy");
  });

  it.each(["\n", "\r\n"])(
    "canonicalizes multiline PEM keys with %j line breaks",
    async (newline) => {
      const f = fixture();
      f.respond({ ...ACCOUNT, public_key: MULTILINE_PEM.replace(/\n/g, newline) });
      expect((await f.call("account")).body).toMatchObject({ publicPem: PEM });
      f.respond({ ...ACCOUNT, jwt: JWT, public_key: MULTILINE_PEM.replace(/\n/g, newline) });
      expect(
        (await f.call("sign", { sessionToken: "fixture-token", review: REVIEW })).body,
      ).toMatchObject({ publicPem: PEM });
    },
  );

  it("allows missing/null optional DID and account metadata", async () => {
    const f = fixture();
    f.respond({
      reviewer_id: "reviewer-1",
      public_key: PEM,
      did: null,
      account_name: null,
      provider: null,
    });
    expect((await f.call("account")).body).toEqual({ reviewerId: "reviewer-1", publicPem: PEM });
  });

  it("relays signing and revocation to the official endpoints with exact bodies", async () => {
    const f = fixture();
    f.respond({ ...ACCOUNT, jwt: JWT, signature: "omitted" });
    expect(await f.call("sign", { sessionToken: "fixture-token", review: REVIEW })).toEqual({
      status: 200,
      body: { jwt: JWT, reviewerId: "reviewer-1", publicPem: PEM, did: "did:plc:example" },
    });
    expect(f.http.calls[0]).toMatchObject({
      url: `${ORIGIN}/reviews/sign`,
      body: JSON.stringify({ session_token: "fixture-token", review: REVIEW }),
    });
    f.respond({ status: 204, headers: {}, body: null });
    expect(await f.call("revoke")).toEqual({ status: 200, body: { ok: true } });
    expect(f.http.calls[1]).toMatchObject({
      url: `${ORIGIN}/auth/revoke`,
      body: JSON.stringify({ session_token: "fixture-token" }),
    });
  });

  it.each(["account", "sign", "revoke"])(
    "rejects stale request owner and malformed tokens before %s acquisition",
    async (path) => {
      const f = fixture();
      expect(
        (
          await f.call(path, {
            sessionToken: "fixture-token",
            expectedUserId: "other",
            review: REVIEW,
          })
        ).status,
      ).toBe(401);
      expect((await f.call(path, { sessionToken: "a".repeat(8193), review: REVIEW })).status).toBe(
        400,
      );
      expect((await f.call(path, { sessionToken: "\n", review: REVIEW })).status).toBe(400);
      expect((await f.call(path, {}, { userId: undefined })).status).toBe(401);
      expect(f.http.calls).toHaveLength(0);
    },
  );

  it.each([
    null,
    [],
    {},
    { sub: "" },
    { sub: "x", iat: 1 },
    { sub: "x", opinion: "x".repeat(140000) },
  ])("rejects malformed or oversized review %j", async (review) => {
    const f = fixture();
    expect((await f.call("sign", { sessionToken: "fixture-token", review })).status).toBe(400);
    expect(f.http.calls).toHaveLength(0);
  });

  it.each(["source", "integration", "policy-failure"])(
    "fails closed before config and all acquisitions on %s denial",
    async (kind) => {
      const f = fixture();
      if (kind === "source") f.sources.add("mangrove-signer");
      if (kind === "integration") f.integrations.add("reviews-mangrove");
      if (kind === "policy-failure")
        f.ctx.getDisallowedSourceIds = async () => {
          throw new Error("fixture-token");
        };
      expect((await f.call("config")).body).toEqual({ configured: false });
      for (const path of ["account", "sign", "revoke"])
        expect((await f.call(path, { sessionToken: "fixture-token", review: REVIEW })).status).toBe(
          503,
        );
      expect(f.http.calls).toHaveLength(0);
      expect(f.log).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}, { admitSharedRequest: {} }])(
    "fails closed without host admission %j",
    async (runtime) => {
      const f = fixture();
      Object.assign(f.ctx, { upstreamRuntime: runtime });
      expect((await f.call("config")).body).toEqual({ configured: false });
      expect((await f.call("account")).status).toBe(503);
      expect(f.http.calls).toHaveLength(0);
    },
  );

  it.each(["store_unavailable", "cooldown", "quota"])(
    "classifies admission denial %s without making a provider request",
    async (reason) => {
      const f = fixture();
      f.admission.mockResolvedValue({ allowed: false, reason, retryAfterMs: 1000 } as never);
      expect((await f.call("account")).status).toBe(reason === "store_unavailable" ? 503 : 429);
      expect(f.http.calls).toHaveLength(0);
    },
  );

  it.each([401, 429, 400, 403, 500, 302])(
    "redacts upstream status %i without retrying",
    async (status) => {
      const f = fixture();
      f.respond({ status, headers: {}, body: { error: "fixture-token" } });
      const result = await f.call("account");
      expect(result.status).toBe([401, 429, 400, 403].includes(status) ? status : 502);
      expect(JSON.stringify(result)).not.toContain("fixture-token");
      expect(f.http.calls).toHaveLength(1);
      expect(f.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { ...ACCOUNT, public_key: "not PEM" },
    {
      ...ACCOUNT,
      public_key: generateKeyPairSync("ec", { namedCurve: "secp384r1" })
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
    },
    {
      ...ACCOUNT,
      public_key: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    { ...ACCOUNT, reviewer_id: [] },
    { ...ACCOUNT, did: {} },
    { ...ACCOUNT, provider: [] },
  ])("rejects malformed account/key responses", async (response) => {
    const f = fixture();
    f.respond(response);
    expect((await f.call("account")).status).toBe(502);
  });

  it("rejects additional data hidden after the SPKI key", async () => {
    const f = fixture();
    const base64 = PEM.replace("-----BEGIN PUBLIC KEY-----", "").replace(
      "-----END PUBLIC KEY-----",
      "",
    );
    const extended = Buffer.concat([
      Buffer.from(base64, "base64"),
      Buffer.from("unexpected-data"),
    ]).toString("base64");
    f.respond({
      ...ACCOUNT,
      public_key: `-----BEGIN PUBLIC KEY-----${extended}-----END PUBLIC KEY-----`,
    });
    expect((await f.call("account")).status).toBe(502);
  });

  it("treats malformed admission decisions as unavailable", async () => {
    const f = fixture();
    f.admission.mockResolvedValue({} as never);
    expect((await f.call("account")).status).toBe(503);
    expect(f.http.calls).toHaveLength(0);
  });

  it("snapshots review content before awaiting admission", async () => {
    const f = fixture();
    const admission = deferred<{ allowed: true; remaining: null }>();
    f.admission.mockImplementation(() => admission.promise);
    const review = { sub: "geo:50,6?q=Original&u=50", rating: 0 };
    f.respond({ ...ACCOUNT, jwt: JWT });
    const result = f.call("sign", { sessionToken: "fixture-token", review });
    await vi.waitFor(() => expect(f.admission).toHaveBeenCalledOnce());
    review.sub = "geo:0,0?q=Changed&u=50";
    admission.resolve({ allowed: true, remaining: null });
    expect((await result).status).toBe(200);
    expect(JSON.parse(String(f.http.calls[0].body))).toEqual({
      session_token: "fixture-token",
      review: { sub: "geo:50,6?q=Original&u=50", rating: 0 },
    });
  });

  it("rejects a malformed signing JWT", async () => {
    const f = fixture();
    f.respond({ ...ACCOUNT, jwt: "broken" });
    expect((await f.call("sign", { sessionToken: "fixture-token", review: REVIEW })).status).toBe(
      502,
    );
  });

  it.each([
    "initial-source-policy",
    "initial-integration-policy",
    "admission",
    "http",
    "publication-policy",
  ])("cannot publish a response after shutdown during %s", async (stage) => {
    const f = fixture();
    const reached = deferred<void>();
    const pending = deferred<never>();
    if (stage === "initial-source-policy")
      f.ctx.getDisallowedSourceIds = async () => {
        reached.resolve();
        return pending.promise;
      };
    if (stage === "initial-integration-policy")
      f.ctx.getDisallowedIntegrationIds = async () => {
        reached.resolve();
        return pending.promise;
      };
    if (stage === "admission")
      f.admission.mockImplementation(() => {
        reached.resolve();
        return pending.promise;
      });
    if (stage === "http") f.respond(pending.promise);
    if (stage === "publication-policy") {
      let checks = 0;
      f.ctx.getDisallowedIntegrationIds = async () => {
        if (++checks === 3) {
          reached.resolve();
          return pending.promise;
        }
        return new Set();
      };
    }
    const result = f.call("account");
    if (stage === "http") await vi.waitFor(() => expect(f.http.calls).toHaveLength(1));
    else await reached.promise;
    await f.shutdown[0]();
    expect((await result).status).toBe(503);
  });

  it("rechecks policy after admission and before network, and after network before publication", async () => {
    const f = fixture();
    f.admission.mockImplementation(async () => {
      f.sources.add("mangrove-signer");
      return { allowed: true, remaining: null };
    });
    expect((await f.call("account")).status).toBe(503);
    expect(f.http.calls).toHaveLength(0);
    const g = fixture();
    const upstream = deferred<unknown>();
    g.respond(upstream.promise);
    const result = g.call("account");
    await vi.waitFor(() => expect(g.http.calls).toHaveLength(1));
    g.integrations.add("reviews-mangrove");
    upstream.resolve(ACCOUNT);
    expect((await result).status).toBe(503);
  });

  it("caller cancellation aborts HTTP and prevents account publication", async () => {
    const f = fixture();
    const upstream = deferred<unknown>();
    f.respond(upstream.promise);
    const caller = new AbortController();
    const result = f.call("account", { sessionToken: "fixture-token" }, { signal: caller.signal });
    await vi.waitFor(() => expect(f.http.calls).toHaveLength(1));
    caller.abort();
    expect((await result).status).toBe(503);
    expect(f.http.calls[0].options?.signal?.aborted).toBe(true);
    upstream.resolve(ACCOUNT);
  });
});
