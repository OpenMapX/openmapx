import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../test/app.js";

const WEB_ORIGIN = "https://openmapx.test";

/** What the mocked Better Auth returns for this request. */
const authState: {
  session: { user: { id: string } } | null;
  token: string | null;
} = { session: { user: { id: "user-A" } }, token: "ott-value" };

/** What the mocked handoff service returns, and what it was asked. */
const handoff: {
  issue: unknown;
  exchange: unknown;
  issued: unknown[];
  exchanged: unknown[];
} = { issue: null, exchange: null, issued: [], exchanged: [] };

vi.mock("../auth.js", () => ({
  auth: {
    api: {
      getSession: async () => authState.session,
      generateOneTimeToken: async () =>
        authState.token === null ? null : { token: authState.token },
    },
  },
}));

vi.mock("../services/mobileAuthHandoff.js", () => ({
  MobileAuthHandoffService: class {
    async issue(input: unknown) {
      handoff.issued.push(input);
      return handoff.issue;
    }
    async exchange(input: unknown) {
      handoff.exchanged.push(input);
      return handoff.exchange;
    }
  },
}));

const VERIFIER = "v".repeat(43);
const CHALLENGE = "c".repeat(43);
const STATE = "s".repeat(22);

let app: FastifyInstance;

beforeAll(async () => {
  process.env.WEB_ORIGIN = WEB_ORIGIN;
  const { mobileAuthRoute } = await import("./mobile-auth.js");
  app = await buildTestApp(mobileAuthRoute, { prefix: "/api" });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  authState.session = { user: { id: "user-A" } };
  authState.token = "ott-value";
  handoff.issue = { ok: true, callbackCode: "code-value", expiresAtMs: 1_700_000_120_000 };
  handoff.exchange = { ok: true, oneTimeToken: "ott-value" };
  handoff.issued = [];
  handoff.exchanged = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

const issue = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/mobile-auth/issue",
    headers: { origin: WEB_ORIGIN, ...headers },
    payload,
  });

const exchange = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/mobile-auth/exchange",
    headers: { origin: WEB_ORIGIN, ...headers },
    payload,
  });

const validIssue = { purpose: "sign-in", codeChallenge: CHALLENGE, state: STATE };
const validExchange = { callbackCode: "a".repeat(43), codeVerifier: VERIFIER, state: STATE };

function jsonBodyWithExactBytes(value: Record<string, unknown>, bytes: number): string {
  const json = JSON.stringify(value);
  const padding = bytes - Buffer.byteLength(json);
  if (padding < 0) throw new Error(`JSON fixture already exceeds ${bytes} bytes`);
  return `${json}${" ".repeat(padding)}`;
}

function expectMobilePrivacy(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.pragma).toBe("no-cache");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}

async function rawChunked(path: "issue" | "exchange", body: string) {
  return app.inject({
    method: "POST",
    url: `/api/mobile-auth/${path}`,
    headers: {
      origin: WEB_ORIGIN,
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    },
    payload: Readable.from([body.slice(0, 2_048), body.slice(2_048)]),
  });
}

describe("POST /mobile-auth/issue", () => {
  it("returns only the callback code", async () => {
    const response = await issue(validIssue);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.callbackCode).toBe("code-value");
    // No token, no user, no redirect target: a server that could be told where
    // to send a code is a server that can be told to send it elsewhere.
    expect(body.token).toBeUndefined();
    expect(body.userId).toBeUndefined();
    expect(body.redirectUri).toBeUndefined();
  });

  it("never caches the response", async () => {
    const response = await issue(validIssue);

    // A one-time token in a shared cache is one somebody else can use.
    expectMobilePrivacy(response);
  });

  it("requires an authenticated session", async () => {
    authState.session = null;

    const response = await issue(validIssue);

    expect(response.statusCode).toBe(401);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });

  it("refuses a cross-origin caller", async () => {
    const response = await issue(validIssue, { origin: "https://evil.example" });

    expect(response.statusCode).toBe(403);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });

  it("refuses a request with no Origin at all", async () => {
    // Every browser sends one on a cross-origin POST, and both callers here are
    // browsers.
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile-auth/issue",
      payload: validIssue,
    });

    expect(response.statusCode).toBe(403);
    expectMobilePrivacy(response);
  });

  it("passes the purpose, challenge and state through unchanged", async () => {
    await issue(validIssue);

    expect(handoff.issued[0]).toMatchObject({
      userId: "user-A",
      purpose: "sign-in",
      codeChallenge: CHALLENGE,
      state: STATE,
      oneTimeToken: "ott-value",
    });
  });

  it("reports a refused handoff as a bad request", async () => {
    handoff.issue = { ok: false, reason: "invalid-request" };

    expect((await issue({ ...validIssue, purpose: "delete-account" })).statusCode).toBe(400);
  });

  it("reports too many outstanding attempts distinctly", async () => {
    handoff.issue = { ok: false, reason: "too-many-attempts" };

    // The one place a distinct status is right: the caller is the legitimate
    // user and can act on it.
    expect((await issue(validIssue)).statusCode).toBe(429);
  });

  it("accepts an exactly 4096-byte JSON body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile-auth/issue",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      payload: jsonBodyWithExactBytes(validIssue, 4_096),
    });

    expect(response.statusCode).toBe(200);
    expect(handoff.issued).toHaveLength(1);
  });

  it("rejects a 4097-byte JSON body before doing any work", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile-auth/issue",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      payload: jsonBodyWithExactBytes(validIssue, 4_097),
    });

    expect(response.statusCode).toBe(413);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });

  it("rejects a chunked 4097-byte body with privacy headers before issuing", async () => {
    const response = await rawChunked("issue", jsonBodyWithExactBytes(validIssue, 4_097));

    expect(response.statusCode).toBe(413);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });

  it("rejects unknown fields before issuing a handoff", async () => {
    const response = await issue({ ...validIssue, unexpected: "value" });

    expect(response.statusCode).toBe(400);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });

  it.each([
    ["codeChallenge", "c".repeat(128), "c".repeat(129)],
    ["state", "s".repeat(128), "s".repeat(129)],
  ] as const)("enforces the maximum length of %s", async (field, maximum, overlong) => {
    expect((await issue({ ...validIssue, [field]: maximum })).statusCode).toBe(200);
    handoff.issued = [];

    const rejected = await issue({ ...validIssue, [field]: overlong });
    expect(rejected.statusCode).toBe(400);
    expectMobilePrivacy(rejected);
    expect(handoff.issued).toEqual([]);
  });

  it("accepts only a declared handoff purpose", async () => {
    const response = await issue({ ...validIssue, purpose: "sign-in-with-an-unlisted-flow" });

    expect(response.statusCode).toBe(400);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });

  it("rejects malformed JSON with privacy headers before issuing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile-auth/issue",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expectMobilePrivacy(response);
    expect(handoff.issued).toEqual([]);
  });
});

describe("POST /mobile-auth/exchange", () => {
  it("returns the one-time token once", async () => {
    const response = await exchange(validExchange);

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toBe("ott-value");
  });

  it("needs no authentication", async () => {
    authState.session = null;

    // That is the whole point: it is how the WebView gets a session.
    expect((await exchange(validExchange)).statusCode).toBe(200);
  });

  it("never caches the response", async () => {
    const response = await exchange(validExchange);

    expectMobilePrivacy(response);
  });

  it("refuses a cross-origin caller", async () => {
    const response = await exchange(validExchange, { origin: "https://evil.example" });

    expect(response.statusCode).toBe(403);
    expectMobilePrivacy(response);
    expect(handoff.exchanged).toEqual([]);
  });

  it("passes the verifier through and never stores it", async () => {
    await exchange(validExchange);

    expect(handoff.exchanged[0]).toMatchObject({
      callbackCode: validExchange.callbackCode,
      codeVerifier: VERIFIER,
      state: STATE,
    });
  });

  it.each([
    { label: "an unknown code", reason: "invalid" },
    { label: "a wrong verifier", reason: "invalid" },
    { label: "an expired handoff", reason: "invalid" },
  ])("reports $label with the same status and body", async ({ reason }) => {
    handoff.exchange = { ok: false, reason };

    const response = await exchange(validExchange);

    // The difference between "no such code" and "wrong verifier" is exactly
    // what an attacker is probing for.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("sets no cookie of its own", async () => {
    const response = await exchange(validExchange);

    // Better Auth's own verify call is what establishes the WebView session.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a 4097-byte fixed-length body before exchange", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile-auth/exchange",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      payload: jsonBodyWithExactBytes(validExchange, 4_097),
    });

    expect(response.statusCode).toBe(413);
    expectMobilePrivacy(response);
    expect(handoff.exchanged).toEqual([]);
  });

  it("rejects a chunked 4097-byte body before exchange without Content-Length", async () => {
    const response = await rawChunked("exchange", jsonBodyWithExactBytes(validExchange, 4_097));

    expect(response.statusCode).toBe(413);
    expectMobilePrivacy(response);
    expect(handoff.exchanged).toEqual([]);
  });

  it("rejects unknown fields before exchanging a handoff", async () => {
    const response = await exchange({ ...validExchange, unexpected: "value" });

    expect(response.statusCode).toBe(400);
    expectMobilePrivacy(response);
    expect(handoff.exchanged).toEqual([]);
  });

  it.each([
    ["callbackCode", "a".repeat(256), "a".repeat(257)],
    ["codeVerifier", "v".repeat(128), "v".repeat(129)],
    ["state", "s".repeat(128), "s".repeat(129)],
  ] as const)("enforces the maximum length of %s", async (field, maximum, overlong) => {
    expect((await exchange({ ...validExchange, [field]: maximum })).statusCode).toBe(200);
    handoff.exchanged = [];

    const rejected = await exchange({ ...validExchange, [field]: overlong });
    expect(rejected.statusCode).toBe(400);
    expectMobilePrivacy(rejected);
    expect(handoff.exchanged).toEqual([]);
  });

  it("rejects malformed JSON with privacy headers before exchange", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile-auth/exchange",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expectMobilePrivacy(response);
    expect(handoff.exchanged).toEqual([]);
  });
});
