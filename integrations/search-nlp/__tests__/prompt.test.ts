import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserMessage } from "../prompt";

const ctx = {
  mapCenter: [2.3522, 48.8566] as [number, number],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

describe("buildSystemPrompt", () => {
  it("contains the 'cafes' category id", () => {
    expect(buildSystemPrompt()).toContain("cafes");
  });

  it("contains the 'outdoor_seating' OSM attribute key", () => {
    expect(buildSystemPrompt()).toContain("outdoor_seating");
  });

  it("mentions 'confidence' (case-insensitive)", () => {
    expect(buildSystemPrompt().toLowerCase()).toContain("confidence");
  });

  it("contains 'restaurants'", () => {
    expect(buildSystemPrompt()).toContain("restaurants");
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
