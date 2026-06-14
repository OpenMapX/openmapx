import { describe, expect, it } from "vitest";
import { formatSpokenDistance } from "../formatting";

describe("formatSpokenDistance", () => {
  it("rounds short metric distances to a speakable 10 m / 50 m grid", () => {
    expect(formatSpokenDistance(56)).toBe("60 m");
    expect(formatSpokenDistance(34)).toBe("30 m");
    expect(formatSpokenDistance(437)).toBe("450 m");
    expect(formatSpokenDistance(212)).toBe("200 m");
  });

  it("never speaks below 10 m", () => {
    expect(formatSpokenDistance(3)).toBe("10 m");
  });

  it("rounds longer metric distances to one decimal km", () => {
    expect(formatSpokenDistance(1234)).toBe("1.2 km");
    expect(formatSpokenDistance(1000)).toBe("1.0 km");
  });

  it("rounds imperial distances to feet then miles", () => {
    expect(formatSpokenDistance(100, "imperial")).toBe("350 ft"); // ~328 ft → nearest 50
    expect(formatSpokenDistance(2000, "imperial")).toBe("1.2 mi"); // ~1.24 mi
  });
});
