import { describe, expect, it } from "vitest";
import type { SearchResult } from "../index";
import { searchResultToCategoryPlace } from "./searchResultToCategoryPlace";

const base: SearchResult = {
  id: "osm:node/1",
  label: "Quê Choa, Alt-Moabit 96D, Berlin",
  coordinates: [13.36, 52.52],
  type: "poi",
  confidence: 0.9,
};

describe("searchResultToCategoryPlace", () => {
  it("uses the first label segment as the name and the rest as the address", () => {
    const p = searchResultToCategoryPlace(base);
    expect(p.id).toBe("osm:node/1");
    expect(p.name).toBe("Quê Choa");
    expect(p.address).toBe("Alt-Moabit 96D, Berlin");
    expect(p.coordinates).toEqual([13.36, 52.52]);
  });

  it("leaves address undefined when the label has no comma", () => {
    const p = searchResultToCategoryPlace({ ...base, label: "Tiergarten" });
    expect(p.name).toBe("Tiergarten");
    expect(p.address).toBeUndefined();
  });
});
