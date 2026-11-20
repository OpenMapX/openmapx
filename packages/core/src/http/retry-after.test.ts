import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "./retry-after";

const NOW = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");

describe("parseRetryAfterMs", () => {
  it("reads integer delta-seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
  });

  it("rounds fractional delta-seconds up to the next whole second", () => {
    expect(parseRetryAfterMs("1.5")).toBe(2_000);
    expect(parseRetryAfterMs("0.01")).toBe(1_000);
    expect(parseRetryAfterMs("3.0")).toBe(3_000);
  });

  it("measures an IMF-fixdate from now", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:30:00 GMT", { now: NOW })).toBe(120_000);
  });

  it("accepts the obsolete RFC 850 and asctime HTTP-date forms", () => {
    expect(parseRetryAfterMs("Wednesday, 21-Oct-26 07:30:00 GMT", { now: NOW })).toBe(120_000);
    expect(parseRetryAfterMs("Wed Oct 21 07:30:00 2026", { now: NOW })).toBe(120_000);
    expect(parseRetryAfterMs("Sun Nov  1 07:28:00 2026", { now: NOW })).toBe(11 * 86_400_000);
  });

  it("reads an RFC 850 year more than 50 years ahead as the past century's", () => {
    // 2077 would be 51 years ahead of the 2026 clock, so "77" is 1977: a Friday, not 2077's Thursday.
    expect(parseRetryAfterMs("Friday, 21-Oct-77 07:30:00 GMT", { now: NOW })).toBe(0);
    expect(parseRetryAfterMs("Thursday, 21-Oct-77 07:30:00 GMT", { now: NOW })).toBeNull();
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
    ["a bare decimal point", "1."],
    ["garbage", "soon"],
    ["another date format", "2026-10-21T07:30:00Z"],
    ["a normalised calendar date", "Thu, 31 Sep 2026 07:30:00 GMT"],
    ["a wrong weekday", "Mon, 21 Oct 2026 07:30:00 GMT"],
    ["an RFC 850 date with a short weekday", "Wed, 21-Oct-26 07:30:00 GMT"],
    ["an asctime date with an unpadded single-digit day", "Sun Nov 1 07:28:00 2026"],
    ["an out-of-range hour", "Wed, 21 Oct 2026 24:30:00 GMT"],
    ["seconds past the safe range", "9".repeat(20)],
  ])("refuses %s", (_label, value) => {
    expect(parseRetryAfterMs(value, { now: NOW })).toBeNull();
  });

  it("passes a huge but safe value through for the caller to cap", () => {
    expect(parseRetryAfterMs("31536000")).toBe(31_536_000_000);
  });
});
