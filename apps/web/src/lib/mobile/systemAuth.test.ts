import { describe, expect, it, vi } from "vitest";
import { readAuthResult, redeemSystemAuth, type SystemAuthHandoff } from "./systemAuth";

const HANDOFF: SystemAuthHandoff = {
  callbackCode: "c".repeat(43),
  state: "s".repeat(22),
  codeVerifier: "v".repeat(43),
};

function deps(
  options: {
    response?: { ok: boolean; status?: number; body?: unknown };
    fetchThrows?: boolean;
    verify?: boolean | (() => never);
  } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const verified: string[] = [];
  let refreshed = 0;

  const value = {
    apiBaseUrl: "https://api.example.test",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (options.fetchThrows) throw new Error("offline");
      const response = options.response ?? { ok: true, body: { token: "ott-value" } };
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 400),
        json: async () => response.body ?? {},
      };
    }) as unknown as typeof globalThis.fetch,
    verifyOneTimeToken: async (token: string) => {
      verified.push(token);
      if (typeof options.verify === "function") options.verify();
      return options.verify === undefined ? true : Boolean(options.verify);
    },
    refreshSession: () => {
      refreshed += 1;
    },
  };

  return { deps: value, calls, verified, refreshed: () => refreshed };
}

describe("redeemSystemAuth", () => {
  it("exchanges the code and establishes the session", async () => {
    const h = deps();

    await expect(redeemSystemAuth(HANDOFF, h.deps)).resolves.toBe("ok");
    expect(h.calls[0].url).toBe("https://api.example.test/mobile-auth/exchange");
    // Better Auth's own verify is what actually sets the cookie.
    expect(h.verified).toEqual(["ott-value"]);
    expect(h.refreshed()).toBe(1);
  });

  it("sends the verifier and never asks the server to store it", async () => {
    const h = deps();

    await redeemSystemAuth(HANDOFF, h.deps);

    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      callbackCode: HANDOFF.callbackCode,
      codeVerifier: HANDOFF.codeVerifier,
      state: HANDOFF.state,
    });
  });

  it("never caches the exchange", async () => {
    const h = deps();

    await redeemSystemAuth(HANDOFF, h.deps);

    expect(h.calls[0].init.cache).toBe("no-store");
    expect(h.calls[0].init.credentials).toBe("include");
  });

  it.each([
    { label: "a missing code", handoff: { ...HANDOFF, callbackCode: "" } },
    { label: "a short verifier", handoff: { ...HANDOFF, codeVerifier: "short" } },
    { label: "a non-base64url state", handoff: { ...HANDOFF, state: "not+valid/state=" } },
  ])("refuses $label before sending anything", async ({ handoff }) => {
    const h = deps();

    await expect(redeemSystemAuth(handoff, h.deps)).resolves.toBe("invalid");
    expect(h.calls).toEqual([]);
  });

  it("reports a refused exchange as invalid", async () => {
    const h = deps({ response: { ok: false, status: 400 } });

    await expect(redeemSystemAuth(HANDOFF, h.deps)).resolves.toBe("invalid");
    expect(h.verified).toEqual([]);
  });

  it("distinguishes a server that is down from one that refused", async () => {
    const h = deps({ response: { ok: false, status: 503 } });

    // One is worth telling the user to try again; the other is a fresh sign-in.
    await expect(redeemSystemAuth(HANDOFF, h.deps)).resolves.toBe("unavailable");
  });

  it("does not retry an ambiguous exchange", async () => {
    const h = deps({ fetchThrows: true });

    await expect(redeemSystemAuth(HANDOFF, h.deps)).resolves.toBe("unavailable");
    // The code may or may not have been consumed; retrying a maybe-consumed
    // code is how a user ends up stuck.
    expect(h.calls).toHaveLength(1);
    expect(h.refreshed()).toBe(0);
  });

  it("reports a token the server would not verify", async () => {
    const h = deps({ verify: false });

    await expect(redeemSystemAuth(HANDOFF, h.deps)).resolves.toBe("invalid");
    expect(h.refreshed()).toBe(0);
  });

  it("returns no token to its caller", async () => {
    const h = deps();

    const result = await redeemSystemAuth(HANDOFF, h.deps);

    // The caller learns whether it worked, which is all it has any use for.
    expect(result).toBe("ok");
    expect(typeof result).toBe("string");
  });

  it("treats a response with no token as invalid", async () => {
    const h = deps({ response: { ok: true, body: {} } });

    await expect(redeemSystemAuth(HANDOFF, h.deps)).resolves.toBe("invalid");
  });
});

describe("readAuthResult", () => {
  it("reads a successful result", () => {
    expect(
      readAuthResult({
        status: "ok",
        handoffCode: "code",
        state: "state",
        codeVerifier: "verifier",
      }),
    ).toEqual({ status: "ok", callbackCode: "code", state: "state", codeVerifier: "verifier" });
  });

  it.each(["cancelled", "failed"] as const)("reads a %s result", (status) => {
    expect(readAuthResult({ status })).toEqual({ status });
  });

  it.each([
    { label: "nothing", payload: undefined },
    { label: "an unknown status", payload: { status: "maybe" } },
    {
      label: "a success with no code",
      payload: { status: "ok", state: "state", codeVerifier: "verifier" },
    },
    {
      label: "a success with no verifier",
      payload: { status: "ok", handoffCode: "code", state: "state" },
    },
    {
      label: "a success with no state",
      payload: { status: "ok", handoffCode: "code", codeVerifier: "verifier" },
    },
  ])("refuses $label", ({ payload }) => {
    // A partial result is a failure, not something to try redeeming with
    // whatever happened to arrive.
    expect(readAuthResult(payload)).toBeNull();
  });
});
