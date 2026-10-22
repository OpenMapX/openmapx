import { describe, expect, it } from "vitest";
import { mostSevereEvent, SEVERITY_COLORS, SEVERITY_LINE_COLOR, SEVERITY_RANK } from "../severity";
import { situation } from "./fixtures";

describe("severity", () => {
  it("ranks a declared no-impact rating lowest, then a missing one, then each stated impact", () => {
    const order = Object.entries(SEVERITY_RANK)
      .sort(([, a], [, b]) => a - b)
      .map(([label]) => label);
    expect(order).toEqual(["none", "unknown", "minor", "moderate", "major", "critical"]);
  });

  it("colours no impact apart from unknown and from every stated impact", () => {
    const colors = Object.values(SEVERITY_COLORS);
    expect(new Set(colors).size).toBe(colors.length);
    expect(SEVERITY_LINE_COLOR).toEqual(expect.arrayContaining(["none", SEVERITY_COLORS.none]));
  });

  it("represents a group by an unknown rating over a declared absence of impact", () => {
    const none = situation({ id: "none", severity: { label: "none" } });
    const unknown = situation({ id: "unknown", severity: { label: "unknown" } });
    expect(mostSevereEvent([none, unknown]).id).toBe("unknown");
  });
});
