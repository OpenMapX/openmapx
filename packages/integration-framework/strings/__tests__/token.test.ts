import { describe, expect, it } from "vitest";
import { sharedStrings, sharedT, token } from "../index.js";
import { resolveToken } from "../src/resolver.js";

describe("token() helper", () => {
  it("builds a bare-key token", () => {
    expect(token("row.freeSpaces")).toEqual({ $t: "row.freeSpaces" });
  });

  it("builds a token with values", () => {
    expect(token("summary.spacesOf", { free: 3, capacity: 10 })).toEqual({
      $t: "summary.spacesOf",
      values: { free: 3, capacity: 10 },
    });
  });
});

describe("sharedT typed constants", () => {
  it("points at the framework catalog under shared.* keys", () => {
    expect(sharedT.row.source).toEqual({ $t: "shared.row.source" });
    expect(sharedT.row.lastUpdated).toEqual({ $t: "shared.row.lastUpdated" });
    expect(sharedT.value.open).toEqual({ $t: "shared.value.open" });
    expect(sharedT.section.source).toEqual({ $t: "shared.section.source" });
  });

  it("resolves against the shipped shared catalog (en)", () => {
    expect(
      resolveToken(sharedT.row.source, {
        locale: "en",
        fallbackLocale: "en",
        shared: sharedStrings,
        integration: undefined,
      }),
    ).toBe("Source");
  });

  it("resolves against the shipped shared catalog (de)", () => {
    expect(
      resolveToken(sharedT.row.source, {
        locale: "de",
        fallbackLocale: "en",
        shared: sharedStrings,
        integration: undefined,
      }),
    ).toBe("Quelle");
  });
});
