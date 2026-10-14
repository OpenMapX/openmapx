import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import {
  contributionsBaseUrl,
  isRecordClass,
  isSafeReportId,
  isSubClaimAction,
  RECORD_CLASSES,
  relayContribution,
  SUBCLAIM_ACTIONS,
} from "../relay.js";

describe("contributionsBaseUrl", () => {
  it("defaults to the contributions-api's own port 4200 when the env var is unset", () => {
    expect(contributionsBaseUrl({})).toBe("http://localhost:4200");
  });

  it("uses the configured URL and strips a trailing slash", () => {
    expect(
      contributionsBaseUrl({ OPENCONDITIONS_CONTRIBUTIONS_URL: "https://contrib.example.org/" }),
    ).toBe("https://contrib.example.org");
  });

  it("falls back to the default for a Compose-injected empty string", () => {
    expect(contributionsBaseUrl({ OPENCONDITIONS_CONTRIBUTIONS_URL: "  " })).toBe(
      "http://localhost:4200",
    );
  });
});

describe("relayContribution", () => {
  it("posts through the host client with a bounded JSON-only, no-redirect policy", async () => {
    const http = fakeHttpClient(() => ({ status: 201, headers: {}, body: { id: "abc" } }));
    const result = await relayContribution(http, "POST", "/contrib/reports", {
      body: { alg: "ES256", signature: "sig" },
      base: "https://contrib.example.org",
    });

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.method).toBe("postResponse");
    expect(call?.url).toBe("https://contrib.example.org/contrib/reports");
    expect(call?.body).toEqual({ alg: "ES256", signature: "sig" });
    expect(call?.options).toMatchObject({
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
      contentTypes: ["application/json"],
      redirect: "error",
    });
    expect(result).toEqual({ status: 201, body: { id: "abc" } });
  });

  it("propagates a non-2xx upstream status and its JSON body", async () => {
    const http = fakeHttpClient(() => ({ status: 409, headers: {}, body: { error: "duplicate" } }));
    const result = await relayContribution(http, "POST", "/contrib/reports", {
      base: "https://contrib.example.org",
    });
    expect(result).toEqual({ status: 409, body: { error: "duplicate" } });
  });

  it("rejects when the host client refuses the upstream answer", async () => {
    const http = fakeHttpClient(() => {
      throw new Error("integration HTTP response has unexpected content type");
    });
    await expect(
      relayContribution(http, "GET", "/contrib/issuer-keys", {
        base: "https://contrib.example.org",
      }),
    ).rejects.toThrow(/content type/);
  });

  it("uses a body-less GET for reads", async () => {
    const http = fakeHttpClient(() => ({ keys: [] }));
    const result = await relayContribution(http, "GET", "/contrib/issuer-keys", {
      base: "https://contrib.example.org",
    });
    expect(http.calls[0]?.method).toBe("getResponse");
    expect(http.calls[0]?.body).toBeUndefined();
    expect(result).toEqual({ status: 200, body: { keys: [] } });
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

describe("isRecordClass", () => {
  it("accepts the record classes and rejects anything else", () => {
    for (const c of RECORD_CLASSES) expect(isRecordClass(c)).toBe(true);
    expect(isRecordClass("report")).toBe(false);
    expect(isRecordClass("..")).toBe(false);
    expect(isRecordClass("")).toBe(false);
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
