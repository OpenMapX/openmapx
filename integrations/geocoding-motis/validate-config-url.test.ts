import { describe, expect, it } from "vitest";
import { assertHttpUrlConfig } from "./validate-config-url";

describe("assertHttpUrlConfig", () => {
  it("accepts http(s) URLs including localhost, and empty/undefined", () => {
    expect(() => assertHttpUrlConfig("http://localhost:8081", "endpoint")).not.toThrow();
    expect(() => assertHttpUrlConfig("https://motis.example.org", "endpoint")).not.toThrow();
    expect(() => assertHttpUrlConfig(undefined, "endpoint")).not.toThrow();
    expect(() => assertHttpUrlConfig("", "endpoint")).not.toThrow();
  });

  it("rejects non-http(s) and malformed URLs", () => {
    expect(() => assertHttpUrlConfig("file:///etc/passwd", "endpoint")).toThrow();
    expect(() => assertHttpUrlConfig("gopher://x", "endpoint")).toThrow();
    expect(() => assertHttpUrlConfig("not a url", "endpoint")).toThrow();
    expect(() => assertHttpUrlConfig(123, "endpoint")).toThrow();
  });
});
