import { afterEach, describe, expect, it, vi } from "vitest";
import { envInt, envString } from "../env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("envString", () => {
  it("returns the fallback when the var is unset", () => {
    vi.stubEnv("OMX_TEST_VAR", undefined);
    expect(envString("OMX_TEST_VAR", "default")).toBe("default");
  });

  it("returns the fallback when the var is an empty string (Compose blank injection)", () => {
    vi.stubEnv("OMX_TEST_VAR", "");
    expect(envString("OMX_TEST_VAR", "default")).toBe("default");
  });

  it("returns the fallback when the var is whitespace-only", () => {
    vi.stubEnv("OMX_TEST_VAR", "   ");
    expect(envString("OMX_TEST_VAR", "default")).toBe("default");
  });

  it("returns the configured value when set", () => {
    vi.stubEnv("OMX_TEST_VAR", "https://example.test/tiles");
    expect(envString("OMX_TEST_VAR", "default")).toBe("https://example.test/tiles");
  });
});

describe("envInt", () => {
  it("returns the fallback when unset, blank, or non-numeric", () => {
    vi.stubEnv("OMX_TEST_PORT", undefined);
    expect(envInt("OMX_TEST_PORT", 587)).toBe(587);
    vi.stubEnv("OMX_TEST_PORT", "");
    expect(envInt("OMX_TEST_PORT", 587)).toBe(587);
    vi.stubEnv("OMX_TEST_PORT", "not-a-number");
    expect(envInt("OMX_TEST_PORT", 587)).toBe(587);
  });

  it("parses a numeric value", () => {
    vi.stubEnv("OMX_TEST_PORT", " 2525 ");
    expect(envInt("OMX_TEST_PORT", 587)).toBe(2525);
  });
});
