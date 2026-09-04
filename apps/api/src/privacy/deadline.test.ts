import { describe, expect, it } from "vitest";
import { calculateSubjectRequestDueAt } from "./deadline.js";

describe("calculateSubjectRequestDueAt", () => {
  it.each([
    ["2024-01-31T12:00:00.000Z", "UTC", "2024-02-29T12:00:00.000Z"],
    ["2023-01-31T12:00:00.000Z", "UTC", "2023-02-28T12:00:00.000Z"],
    ["2024-02-29T12:00:00.000Z", "UTC", "2024-03-29T12:00:00.000Z"],
  ])("adds one calendar month (%s)", (received, timeZone, expected) => {
    expect(calculateSubjectRequestDueAt(new Date(received), timeZone)).toEqual(new Date(expected));
  });

  it("preserves a local wall-clock deadline through a DST transition", () => {
    expect(
      calculateSubjectRequestDueAt(new Date("2024-03-30T12:00:00.000Z"), "Europe/Berlin"),
    ).toEqual(new Date("2024-04-30T11:00:00.000Z"));
  });

  it("rejects malformed dates and time zones", () => {
    expect(() => calculateSubjectRequestDueAt(new Date("invalid"), "UTC")).toThrow("receivedAt");
    expect(() => calculateSubjectRequestDueAt(new Date(), "Not/AZone")).toThrow("timeZone");
  });
});
