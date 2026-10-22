import { describe, expect, it } from "vitest";
import { parseElapsedDurationSeconds } from "../elapsed-duration.js";

describe("nonnegative fixed elapsed duration", () => {
  it.each<[string, number]>([
    ["PT0S", 0],
    ["P0D", 0],
    ["P0DT0H0M0S", 0],
    ["P2D", 172800],
    ["P1DT2H3M4.5S", 93784.5],
    ["PT1H23M40S", 5020],
    ["PT120M", 7200],
    ["PT90S", 90],
    ["PT0.5S", 0.5],
    ["PT1.2345S", 1.2345],
    ["P001DT02H", 93600],
  ])("parses %s as %s seconds without rounding", (input, expected) => {
    expect(parseElapsedDurationSeconds(input)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "P",
    "PT",
    "P1DT",
    "garbagePT1Hgarbage",
    "PT1Hjunk",
    "PT1H\n",
    " PT1H",
    "PT1H ",
    "pt1h",
    "P1Y",
    "P1M",
    "P1W",
    "-PT1S",
    "+PT1S",
    "P0.5D",
    "PT0.5H",
    "PT0.5M",
    "PT.5S",
    "PT5.S",
    "PT1,5S",
    "PT1e3S",
    "PT1M1H",
    "PT1H1H",
    "P1D1D",
    "P1DT1",
    "1H",
    "PTNaNS",
    "PTInfinityS",
    `P${"9".repeat(400)}D`,
  ])("rejects unsupported or malformed input %j", (input) => {
    expect(parseElapsedDurationSeconds(input)).toBeUndefined();
  });
});
