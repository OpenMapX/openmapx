import { describe, expect, it } from "vitest";
import { formatInTimeZone, tzDiffMinutes, tzOffsetLabel, tzOffsetMinutes } from "../timezone";

const WINTER = new Date("2026-01-15T12:00:00Z");
const SUMMER = new Date("2026-07-15T12:00:00Z");

describe("tzOffsetMinutes", () => {
  it("follows northern-hemisphere DST", () => {
    expect(tzOffsetMinutes(WINTER, "Europe/Berlin")).toBe(60);
    expect(tzOffsetMinutes(SUMMER, "Europe/Berlin")).toBe(120);
  });

  it("follows southern-hemisphere DST in the opposite direction", () => {
    expect(tzOffsetMinutes(WINTER, "Australia/Sydney")).toBe(660);
    expect(tzOffsetMinutes(SUMMER, "Australia/Sydney")).toBe(600);
  });

  it("handles sub-hour offsets", () => {
    expect(tzOffsetMinutes(WINTER, "Asia/Kathmandu")).toBe(345);
  });

  it("handles negative offsets", () => {
    expect(tzOffsetMinutes(WINTER, "America/New_York")).toBe(-300);
  });
});

describe("tzOffsetLabel", () => {
  it("renders whole and fractional offsets", () => {
    expect(tzOffsetLabel(SUMMER, "Europe/Berlin")).toBe("UTC+2");
    expect(tzOffsetLabel(WINTER, "Asia/Kathmandu")).toBe("UTC+5:45");
    expect(tzOffsetLabel(WINTER, "America/New_York")).toBe("UTC-5");
    expect(tzOffsetLabel(WINTER, "UTC")).toBe("UTC");
  });
});

describe("tzDiffMinutes", () => {
  it("is the signed difference between two zones at an instant", () => {
    expect(tzDiffMinutes(SUMMER, "Europe/Berlin", "Asia/Tokyo")).toBe(420);
    expect(tzDiffMinutes(SUMMER, "Asia/Tokyo", "Europe/Berlin")).toBe(-420);
    expect(tzDiffMinutes(SUMMER, "Europe/Berlin", "Europe/Berlin")).toBe(0);
  });
});

describe("formatInTimeZone", () => {
  it("renders the wall clock of the target zone", () => {
    expect(formatInTimeZone(new Date("2026-07-15T10:00:00Z"), "Europe/Berlin", "en-GB")).toBe(
      "12:00",
    );
    expect(formatInTimeZone(new Date("2026-07-15T10:00:00Z"), "Asia/Tokyo", "en-GB")).toBe("19:00");
  });
});
