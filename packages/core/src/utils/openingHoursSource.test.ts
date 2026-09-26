import { describe, expect, it } from "vitest";
import { openingHoursSourceFromOsm } from "./openingHoursSource";

describe("opening hours source metadata", () => {
  it("uses the field-specific check date and source tag", () => {
    expect(
      openingHoursSourceFromOsm(
        "osm:way/210081990",
        { "source:opening_hours": "survey", "check_date:opening_hours": "2026-09-01" },
        new Date("2026-09-26T10:00:00Z"),
      ),
    ).toEqual({ name: "survey", checkedAt: "2026-09-01" });
  });

  it("keeps source but omits malformed, future or whole-place dates", () => {
    const at = new Date("2026-09-26T10:00:00Z");
    for (const tag of ["bad", "2026-09-27", "2026-02-30"]) {
      expect(
        openingHoursSourceFromOsm("osm:way/1", { "opening_hours:check_date": tag }, at),
      ).toEqual({ name: "OpenStreetMap", url: "https://www.openstreetmap.org/way/1" });
    }
  });

  it("does not turn a generic updatedAt or fetch time into an hours check", () => {
    expect(openingHoursSourceFromOsm("osm:node/2", {}, new Date("2026-09-26"))).toEqual({
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org/node/2",
    });
  });
});
