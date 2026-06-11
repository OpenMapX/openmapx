import { describe, expect, it } from "vitest";
import { classifyQuery } from "../queryClassifier";

describe("classifyQuery", () => {
  it('classifies coordinate strings as "coordinate"', () => {
    expect(classifyQuery("48.8566, 2.3522")).toBe("coordinate");
  });

  it('classifies NL queries with spatial signals as "nl"', () => {
    expect(classifyQuery("quiet cafe with outdoor seating near the park")).toBe("nl");
  });

  it('classifies questions starting with "where" as "nl"', () => {
    expect(classifyQuery("where is the nearest hospital?")).toBe("nl");
  });

  it('classifies accessibility queries as "nl"', () => {
    expect(classifyQuery("wheelchair accessible museum")).toBe("nl");
  });

  it('classifies landmark names as "geocode"', () => {
    expect(classifyQuery("Eiffel Tower")).toBe("geocode");
  });

  it('classifies city names as "geocode"', () => {
    expect(classifyQuery("Berlin")).toBe("geocode");
  });

  it('classifies "Nice, France" as "geocode" (not "nl" despite word "nice")', () => {
    expect(classifyQuery("Nice, France")).toBe("geocode");
  });

  it('classifies out-of-range lat/lng pair as "geocode" not "coordinate"', () => {
    // lat=91 exceeds [-90,90] — should fall through to geocode
    expect(classifyQuery("91, 200")).toBe("geocode");
  });

  it('classifies boundary coordinates at exact limits as "coordinate"', () => {
    expect(classifyQuery("90, 180")).toBe("coordinate");
    expect(classifyQuery("-90, -180")).toBe("coordinate");
  });

  it('does not classify "best pizza in town" as "nl" via removed "best" signal', () => {
    // "best" was removed from adjective list; geocoding runs in parallel anyway
    expect(classifyQuery("best pizza in town")).toBe("geocode");
  });
});
