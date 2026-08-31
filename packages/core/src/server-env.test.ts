import { describe, expect, it } from "vitest";
import { envInt, envString } from "./server-env";

describe("envString", () => {
  it.each([undefined, "", "   "])("uses the fallback for %j", (value) => {
    expect(envString("SETTING", "fallback", { SETTING: value })).toBe("fallback");
  });

  it("preserves a configured non-blank value", () => {
    expect(envString("SETTING", "fallback", { SETTING: " value " })).toBe(" value ");
  });
});

describe("envInt", () => {
  it.each([undefined, "", "   ", "not-a-number", "Infinity", "-Infinity", "NaN"])(
    "uses the fallback for %j",
    (value) => {
      expect(envInt("SETTING", 587, { SETTING: value })).toBe(587);
    },
  );

  it.each([
    [" 2525 ", 2525],
    ["0", 0],
    ["-1", -1],
  ])("parses %j as %d", (value, expected) => {
    expect(envInt("SETTING", 587, { SETTING: value })).toBe(expected);
  });
});
