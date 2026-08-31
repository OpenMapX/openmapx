import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPoiAdminTimestamp, formatTransitAdminTimestamp } from "./adminTimestamp";

describe("admin timestamp formatting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps missing values visually empty", () => {
    expect(formatTransitAdminTimestamp(null)).toBe("—");
    expect(formatPoiAdminTimestamp(null)).toBe("—");
  });

  it("formats transit timestamps with the existing locale fields", () => {
    const localeString = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("Aug 31, 2026, 02:34 PM");

    expect(formatTransitAdminTimestamp("2026-08-31T12:34:56.000Z")).toBe("Aug 31, 2026, 02:34 PM");
    expect(localeString).toHaveBeenCalledWith(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  });

  it("returns the transit input when locale formatting fails", () => {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(() => {
      throw new RangeError("unsupported date");
    });

    expect(formatTransitAdminTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("keeps POI timestamps in their compact ISO-shaped display", () => {
    expect(formatPoiAdminTimestamp("2026-08-31T12:34:56.000Z")).toBe("2026-08-31 12:34");
    expect(formatPoiAdminTimestamp("not-a-date")).toBe("not-a-date");
  });
});
