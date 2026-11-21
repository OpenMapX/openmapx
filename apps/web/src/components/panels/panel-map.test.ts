import { describe, expect, it } from "vitest";
import { SIDEBAR_PANELS } from "./panel-map";
import { DIRECTIONS_DETENTS, PLACE_DETENTS } from "./sheet/detents";

function panel(id: string) {
  const entry = SIDEBAR_PANELS[id];
  if (!entry) throw new Error(`no sidebar panel ${id}`);
  return entry;
}

describe("panel-map", () => {
  it("leaves search-bar clearance to the shell except where the panel handles the bar itself", () => {
    const overrides = Object.fromEntries(
      Object.entries(SIDEBAR_PANELS)
        .filter(([, entry]) => entry.searchBarClearance !== undefined)
        .map(([id, entry]) => [id, entry.searchBarClearance]),
    );
    expect(overrides).toEqual({ place: "content", directions: "none" });
  });

  it("place and directions carry their own mobile sheet detents", () => {
    expect(panel("place").detents).toBe(PLACE_DETENTS);
    expect(panel("directions").detents).toBe(DIRECTIONS_DETENTS);
  });

  it("the remaining sidebar panels leave detents unset, falling back to SidebarShell's default", () => {
    expect(panel("category").detents).toBeUndefined();
    expect(panel("datasource").detents).toBeUndefined();
    expect(panel("saved").detents).toBeUndefined();
    expect(panel("timeline").detents).toBeUndefined();
  });
});
