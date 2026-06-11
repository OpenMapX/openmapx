import { describe, expect, it } from "vitest";
import { httpCacheKey } from "../http-cache-key.js";

describe("httpCacheKey", () => {
  it("test 1: no headers returns bare URL key (backward compatible)", () => {
    const url = "https://api.example.com/v1/routes?origin=Berlin";
    expect(httpCacheKey(url)).toBe(`int:http:${url}`);
    expect(httpCacheKey(url, {})).toBe(`int:http:${url}`);
  });

  it("test 2: same URL with different header values produces different keys", () => {
    const url = "https://api.example.com/data";
    const keyA = httpCacheKey(url, { authorization: "Bearer token-A" });
    const keyB = httpCacheKey(url, { authorization: "Bearer token-B" });
    expect(keyA).not.toBe(keyB);
  });

  it("test 3: same headers in different insertion order / different case produce the same key", () => {
    const url = "https://api.example.com/data";
    const keyA = httpCacheKey(url, {
      Authorization: "Bearer secret",
      "accept-language": "de",
    });
    const keyB = httpCacheKey(url, {
      "accept-language": "de",
      authorization: "Bearer secret",
    });
    expect(keyA).toBe(keyB);
  });

  it("test 4: no raw header value appears as a substring of the key", () => {
    const url = "https://api.example.com/secure";
    const secret = "super-secret-api-key-12345";
    const key = httpCacheKey(url, { "x-api-key": secret });
    expect(key).not.toContain(secret);
    // Confirm key contains the expected shape
    expect(key).toMatch(/^int:http:https:\/\/api\.example\.com\/secure#h=[0-9a-f]{16}$/);
  });
});
