import { describe, expect, it } from "vitest";
import { matchesDeclaredType, SETTING_DEFS } from "./services/settings";

describe("operator authentication policy drafts", () => {
  it.each([
    ["sessionDurationHours", 0],
    ["sessionDurationHours", 8761],
    ["sessionDurationHours", 1.5],
    ["passwordMinLength", 7],
    ["passwordMinLength", 129],
  ])("rejects unsafe %s=%s before persistence", (key, value) => {
    const definition = SETTING_DEFS.find((d) => d.key === key);
    if (!definition) throw Error("Missing setting definition");
    expect(matchesDeclaredType(definition, value)).toBe(false);
  });
  it.each(["emailVerificationRequired", "twoFaEnabled"])(
    "displays the secure %s default until explicit activation",
    (key) => {
      expect(SETTING_DEFS.find((d) => d.key === key)?.default).toBe(true);
    },
  );
});
