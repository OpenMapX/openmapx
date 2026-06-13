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

  it('classifies German proximity queries as "nl"', () => {
    // The exact query that regressed in Aachen.
    expect(classifyQuery("Schulen in meiner Nähe")).toBe("nl");
    expect(classifyQuery("Restaurants in der Nähe")).toBe("nl");
    expect(classifyQuery("Apotheken in der Umgebung")).toBe("nl");
  });

  it('classifies German question/quality/time queries as "nl"', () => {
    expect(classifyQuery("Wo ist die nächste Tankstelle?")).toBe("nl");
    expect(classifyQuery("günstige Hotels mit Parkplatz")).toBe("nl");
    expect(classifyQuery("Supermarkt jetzt geöffnet")).toBe("nl");
    expect(classifyQuery("vegane Restaurants mit Außenbereich")).toBe("nl");
  });

  it('still classifies German place names as "geocode"', () => {
    expect(classifyQuery("Aachen")).toBe("geocode");
    expect(classifyQuery("Karlsruhe Hauptbahnhof")).toBe("geocode");
    expect(classifyQuery("Müllerstraße 5, Berlin")).toBe("geocode");
  });

  it('classifies "with"/"mit" compositional queries as "nl"', () => {
    // The exact query that regressed to a far-away geocode match in Aachen.
    expect(classifyQuery("Park mit See in Aachen")).toBe("nl");
    expect(classifyQuery("cafe with a view")).toBe("nl");
    expect(classifyQuery("Restaurant ohne Sitzplätze")).toBe("nl");
    expect(classifyQuery("restaurants without a dress code")).toBe("nl");
  });

  it('does not match "mit"/"with" inside place names', () => {
    // Word-boundary anchored: these must stay "geocode".
    expect(classifyQuery("Berlin Mitte")).toBe("geocode");
    expect(classifyQuery("Schmitt Bakery")).toBe("geocode");
    expect(classifyQuery("Whitby")).toBe("geocode");
  });
});
