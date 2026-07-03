import { describe, expect, it } from "vitest";
import { DETAIL_PANELS, SIDEBAR_PANELS } from "./panel-map";

describe("panel-map", () => {
  it("SIDEBAR_PANELS has exactly the expected panel ids, each with a truthy component", () => {
    expect(Object.keys(SIDEBAR_PANELS).sort()).toEqual(
      ["category", "datasource", "directions", "place", "saved"].sort(),
    );
    for (const entry of Object.values(SIDEBAR_PANELS)) {
      expect(entry.component).toBeDefined();
    }
  });

  it("SIDEBAR_PANELS.saved carries the panel chrome padding override", () => {
    expect(SIDEBAR_PANELS.saved.contentSx).toBeDefined();
  });

  it("DETAIL_PANELS has exactly the place-card id with a truthy component", () => {
    expect(Object.keys(DETAIL_PANELS)).toEqual(["place-card"]);
    expect(DETAIL_PANELS["place-card"]).toBeDefined();
  });
});
