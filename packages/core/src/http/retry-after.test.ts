import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "./retry-after";

const NOW = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");

describe("parseRetryAfterMs", () => {
  it("reads integer delta-seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
  });

  it("measures an IMF-fixdate from now", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:30:00 GMT", { now: NOW })).toBe(120_000);
  });

  it("measures an IMF-fixdate from the server's Date header when it has one", () => {
    expect(
      parseRetryAfterMs("Wed, 21 Oct 2026 07:30:00 GMT", {
        now: NOW + 3_600_000,
        serverDate: "Wed, 21 Oct 2026 07:29:00 GMT",
      }),
    ).toBe(60_000);
    expect(
      parseRetryAfterMs("Wed, 21 Oct 2026 07:30:00 GMT", { now: NOW, serverDate: "garbage" }),
    ).toBe(120_000);
  });

  it("treats a date already past as no wait", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:00:00 GMT", { now: NOW })).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["empty", " "],
    ["negative", "-5"],
    ["fractional", "1.5"],
    ["garbage", "soon"],
    ["another date format", "2026-10-21T07:30:00Z"],
    ["a normalised calendar date", "Thu, 31 Sep 2026 07:30:00 GMT"],
    ["a wrong weekday", "Mon, 21 Oct 2026 07:30:00 GMT"],
    ["seconds past the safe range", "9".repeat(20)],
  ])("refuses %s", (_label, value) => {
    expect(parseRetryAfterMs(value, { now: NOW })).toBeNull();
  });

  it("passes a huge but safe value through for the caller to cap", () => {
    expect(parseRetryAfterMs("31536000")).toBe(31_536_000_000);
  });
});
