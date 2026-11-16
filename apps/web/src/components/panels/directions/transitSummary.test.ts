import { describe, expect, it } from "vitest";
import { summaryChainLegs, tripPlaceName } from "./transitSummary";

describe("summaryChainLegs", () => {
  it("names the rides, or the walk when there is nothing else", () => {
    const walk = { mode: "walking" };
    const bus = { mode: "bus" };
    expect(summaryChainLegs([walk, bus, walk])).toEqual([bus]);
    expect(summaryChainLegs([walk])).toEqual([walk]);
  });
});

describe("tripPlaceName", () => {
  it("keeps a stop's own name", () => {
    expect(tripPlaceName({ stopId: "s1", name: "Alexanderplatz" }, "Home")).toBe("Alexanderplatz");
  });

  it("names the trip's own start or end with the place the rider chose", () => {
    expect(tripPlaceName({ name: "END" }, "Potsdamer Platz")).toBe("Potsdamer Platz");
    expect(tripPlaceName({ name: "END" }, "")).toBe("END");
  });
});
