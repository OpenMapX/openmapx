/**
 * Unit tests for env-value coercion. Env vars are always strings, so numeric,
 * boolean and array configSchema keys set via `INTEGRATION_<ID>_<KEY>` must be
 * coerced to their declared type — otherwise consumers that type-check (e.g.
 * `typeof === "number"`) silently drop the override.
 */

import { describe, expect, it } from "vitest";
import { coerceEnvValue, isEnvValuePresent } from "./integration-config";

describe("coerceEnvValue", () => {
  it("coerces integer and number types to numbers", () => {
    expect(coerceEnvValue("15000", "integer")).toBe(15000);
    expect(coerceEnvValue("2.5", "number")).toBe(2.5);
  });

  it("leaves a non-numeric string as-is for numeric types", () => {
    expect(coerceEnvValue("not-a-number", "integer")).toBe("not-a-number");
  });

  it("coerces boolean types from common truthy/falsy spellings", () => {
    for (const t of ["true", "1", "yes", "TRUE", "Yes"]) {
      expect(coerceEnvValue(t, "boolean")).toBe(true);
    }
    for (const f of ["false", "0", "no", "FALSE", "No"]) {
      expect(coerceEnvValue(f, "boolean")).toBe(false);
    }
  });

  it("parses array types from JSON or comma-separated lists", () => {
    expect(coerceEnvValue('["local","keyword"]', "array")).toEqual(["local", "keyword"]);
    expect(coerceEnvValue("local, keyword", "array")).toEqual(["local", "keyword"]);
    expect(coerceEnvValue("", "array")).toEqual([]);
  });

  it("passes strings and unknown/undefined types through unchanged", () => {
    expect(coerceEnvValue("http://local-ai:11434", "string")).toBe("http://local-ai:11434");
    expect(coerceEnvValue("http://local-ai:11434", undefined)).toBe("http://local-ai:11434");
  });
});

describe("isEnvValuePresent", () => {
  it("treats undefined as absent", () => {
    expect(isEnvValuePresent(undefined)).toBe(false);
  });

  it("treats an empty string as absent, not a real override", () => {
    // Compose's `${VAR:-}` convention injects "" for an unset var. An empty
    // string must NOT be treated as present, or it would silently override a
    // lower-priority (vault/database) value with "" instead of leaving it alone.
    expect(isEnvValuePresent("")).toBe(false);
  });

  it("treats any non-empty string as present", () => {
    expect(isEnvValuePresent("some-value")).toBe(true);
    expect(isEnvValuePresent("0")).toBe(true);
    expect(isEnvValuePresent(" ")).toBe(true);
  });
});
