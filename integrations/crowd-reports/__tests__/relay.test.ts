import { describe, expect, it, vi } from "vitest";
import {
  contributionsBaseUrl,
  isSafeReportId,
  isSubClaimAction,
  relayContribution,
  SUBCLAIM_ACTIONS,
} from "../relay.js";

function fakeResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

describe("contributionsBaseUrl", () => {
  it("defaults to localhost:3002 when the env var is unset", () => {
    expect(contributionsBaseUrl({})).toBe("http://localhost:3002");
  });

  it("uses the configured URL and strips a trailing slash", () => {
    expect(
      contributionsBaseUrl({ OPENCONDITIONS_CONTRIBUTIONS_URL: "https://contrib.example.org/" }),
    ).toBe("https://contrib.example.org");
  });

  it("falls back to the default for a Compose-injected empty string", () => {
    expect(contributionsBaseUrl({ OPENCONDITIONS_CONTRIBUTIONS_URL: "  " })).toBe(
      "http://localhost:3002",
    );
  });
});

describe("relayContribution", () => {
  it("forwards to the configured base URL and passes body + status through", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(201, { id: "abc" }));
    const result = await relayContribution("POST", "/contrib/reports", {
      body: { alg: "ES256", signature: "sig" },
      base: "https://contrib.example.org",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://contrib.example.org/contrib/reports");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ alg: "ES256", signature: "sig" }));
    expect(result).toEqual({ status: 201, body: { id: "abc" } });
  });

  it("propagates a non-2xx upstream status and its JSON body", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(409, { error: "duplicate" }));
    const result = await relayContribution("POST", "/contrib/reports", {
      base: "https://contrib.example.org",
      fetchImpl,
    });
    expect(result).toEqual({ status: 409, body: { error: "duplicate" } });
  });

  it("wraps a non-JSON upstream body as { raw }", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, "not-json"));
    const result = await relayContribution("GET", "/contrib/issuer-keys", {
      base: "https://contrib.example.org",
      fetchImpl,
    });
    expect(result).toEqual({ status: 200, body: { raw: "not-json" } });
  });

  it("sends no body for a GET", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, {}));
    await relayContribution("GET", "/contrib/issuer-keys", {
      base: "https://contrib.example.org",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
  });
});

describe("isSubClaimAction", () => {
  it("accepts the allowed actions and rejects anything else", () => {
    for (const a of SUBCLAIM_ACTIONS) expect(isSubClaimAction(a)).toBe(true);
    expect(isSubClaimAction("delete")).toBe(false);
    expect(isSubClaimAction("../admin")).toBe(false);
    expect(isSubClaimAction("")).toBe(false);
  });
});

describe("isSafeReportId", () => {
  it("accepts a normal report id", () => {
    expect(isSafeReportId("crowd:key:nonce")).toBe(true);
    expect(isSafeReportId("abc123")).toBe(true);
  });

  it("rejects traversal, slash-bearing, and empty ids", () => {
    expect(isSafeReportId(".")).toBe(false);
    expect(isSafeReportId("..")).toBe(false);
    expect(isSafeReportId("")).toBe(false);
    expect(isSafeReportId("   ")).toBe(false);
    expect(isSafeReportId("a/b")).toBe(false);
    expect(isSafeReportId("a\\b")).toBe(false);
  });
});
