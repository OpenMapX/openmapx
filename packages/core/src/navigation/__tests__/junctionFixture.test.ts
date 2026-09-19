import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Route } from "../../types/routing";

interface Fixture {
  manifest: { capturedAt: string; synthetic: string[] };
  route: Route;
  ways: { wayId: number; tags: Record<string, string> }[];
  images: { id: string; properties: Record<string, unknown>; providers?: unknown }[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "../__fixtures__/junction/a57-neuss-exit20.json"), "utf8"),
) as Fixture;

describe("A57 Neuss exit 20 golden fixture", () => {
  it("has the expected OSM ways", () => {
    expect(fixture.ways.map((w) => w.wayId).sort((a, b) => a - b)).toEqual([
      163585518, 314653466, 314653469,
    ]);
  });

  it("carries the live exit sign and five lanes on the exit step", () => {
    const exitStep = fixture.route.steps[1];
    expect(exitStep.sign?.exitNumbers).toEqual(["20"]);
    expect(exitStep.sign?.exitToward).toEqual(["Neuss-Zentrum"]);
    expect(exitStep.lanes).toHaveLength(5);
    // The live exit maneuver is unflagged (the ramp edge is not motorway
    // class); the preceding motorway step carries the flag.
    expect(fixture.route.steps[0].motorway).toBe(true);
    expect(exitStep.motorway).toBeUndefined();
    expect(exitStep.bearingBefore).toBe(283);
    expect(exitStep.bearingAfter).toBe(300);
  });

  it("holds imagery from 2019 and 2025 in the live item shape", () => {
    expect(fixture.images.length).toBeGreaterThanOrEqual(6);
    const in2019 = fixture.images.filter((i) => String(i.properties.datetime).startsWith("2019"));
    const in2025 = fixture.images.filter((i) => String(i.properties.datetime).startsWith("2025"));
    expect(in2019.length).toBeGreaterThanOrEqual(3);
    expect(in2025.length).toBeGreaterThanOrEqual(2);
    // Live Panoramax items carry providers at the Feature top level and the
    // producer as a plain string, never under properties.
    for (const image of fixture.images) {
      expect(Array.isArray(image.providers)).toBe(true);
      expect(image.properties.providers).toBeUndefined();
    }
    expect(fixture.images.every((i) => typeof i.properties["geovisio:producer"] === "string")).toBe(
      true,
    );
  });
});
