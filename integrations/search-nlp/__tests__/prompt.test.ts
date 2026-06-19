import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserMessage } from "../prompt";

const ctx = {
  mapCenter: [2.3522, 48.8566] as [number, number],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

describe("buildSystemPrompt", () => {
  it("mentions 'selectors' (the OR'd category groups)", () => {
    expect(buildSystemPrompt()).toContain("selectors");
  });

  it("mentions 'require' (AND'd across all selectors)", () => {
    expect(buildSystemPrompt()).toContain("require");
  });

  it("mentions 'exclude' (negated AND'd across all selectors)", () => {
    expect(buildSystemPrompt()).toContain("exclude");
  });

  it("mentions all three ops: '=', '~', 'exists'", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"="');
    expect(prompt).toContain('"~"');
    expect(prompt).toContain("exists");
  });

  it("includes amenity=cafe in the tag cookbook", () => {
    expect(buildSystemPrompt()).toContain("amenity");
    expect(buildSystemPrompt()).toContain("cafe");
  });

  it("includes shop=bakery in the tag cookbook", () => {
    expect(buildSystemPrompt()).toContain("shop=bakery");
  });

  it("includes amenity=charging_station (EV charging) in the tag cookbook", () => {
    expect(buildSystemPrompt()).toContain("charging_station");
  });

  it("contains 'restaurants' and relevant amenity values", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("restaurants");
    expect(prompt).toContain("restaurant");
  });

  it("contains 'outdoor_seating' as an attribute example", () => {
    expect(buildSystemPrompt()).toContain("outdoor_seating");
  });

  it("mentions 'confidence' (case-insensitive)", () => {
    expect(buildSystemPrompt().toLowerCase()).toContain("confidence");
  });

  it("contains 'current_view' spatial constraint description", () => {
    expect(buildSystemPrompt()).toContain("current_view");
  });

  it("mentions 'sort_by' or related sorting rules", () => {
    const prompt = buildSystemPrompt().toLowerCase();
    expect(prompt).toContain("sort_by");
  });

  it("instructs to respond with JSON only", () => {
    const prompt = buildSystemPrompt().toLowerCase();
    expect(prompt).toContain("json");
  });

  it("instructs that time/opening-hours intent goes in time_constraint, not filter", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("time_constraint");
  });

  it("mentions 'unmapped_attributes' for qualities with no OSM tag", () => {
    expect(buildSystemPrompt()).toContain("unmapped_attributes");
  });

  it("includes a worked example showing diet:vegan and internet_access", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("diet:vegan");
    expect(prompt).toContain("internet_access");
  });

  it("instructs model to emit only real OSM tags", () => {
    const prompt = buildSystemPrompt().toLowerCase();
    expect(prompt).toContain("osm");
  });

  it("does not reference the old 'categories' array vocabulary", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain('"categories"');
    expect(prompt).not.toContain("categories: [");
  });

  it("instructs empty selectors ([]) for place-name/address queries, not a 'name exists' selector", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"selectors": []');
    expect(prompt).not.toContain('"key": "name"');
  });
});

describe("buildUserMessage", () => {
  it("contains the query string", () => {
    const msg = buildUserMessage("quiet cafe near me", ctx, 2);
    expect(msg).toContain("quiet cafe near me");
  });

  it("rounds latitude to 2 decimal places (48.86)", () => {
    const msg = buildUserMessage("quiet cafe near me", ctx, 2);
    expect(msg).toContain("48.86");
  });

  it("rounds longitude to 2 decimal places (2.35)", () => {
    const msg = buildUserMessage("quiet cafe near me", ctx, 2);
    expect(msg).toContain("2.35");
  });

  it("includes both lat and lng labels", () => {
    const msg = buildUserMessage("test", ctx, 2);
    expect(msg.toLowerCase()).toContain("lat");
    expect(msg.toLowerCase()).toContain("lng");
  });

  it("respects the roundDecimals parameter", () => {
    const msg = buildUserMessage("test", ctx, 4);
    expect(msg).toContain("48.8566");
    expect(msg).toContain("2.3522");
  });
});
