import { describe, expect, it } from "vitest";
import { SCORE_CUTOFF, scoreCommand } from "./score";
import type { Command } from "./types";

function makeCmd(overrides: Partial<Command>): Command {
  return {
    id: "test",
    group: "actions",
    label: "Test",
    iconKey: "test",
    run: () => {},
    ...overrides,
  };
}

describe("scoreCommand", () => {
  it("returns a high score for exact prefix match", () => {
    const cmd = makeCmd({ label: "Satellite" });
    const exact = scoreCommand("satellite", cmd);
    const prefix = scoreCommand("sat", cmd);
    expect(exact).toBeGreaterThan(0.9);
    expect(prefix).toBeGreaterThan(0.4);
  });

  it("returns a moderate score for substring match", () => {
    const cmd = makeCmd({ label: "Toggle satellite layer" });
    const score = scoreCommand("sat", cmd);
    expect(score).toBeGreaterThan(SCORE_CUTOFF);
  });

  it("scores keyword hits", () => {
    const dark = makeCmd({ label: "Toggle theme", keywords: ["dark", "night"] });
    const noKw = makeCmd({ label: "Toggle theme" });
    expect(scoreCommand("dark", dark)).toBeGreaterThan(scoreCommand("dark", noKw));
  });

  it("gives a small bonus to active toggles", () => {
    const off = makeCmd({ label: "Satellite" });
    const on = makeCmd({ label: "Satellite", isActive: () => true });
    expect(scoreCommand("sat", on)).toBeGreaterThan(scoreCommand("sat", off));
  });

  it("ranks prefix above substring", () => {
    const a = makeCmd({ id: "a", label: "Saved places" });
    const b = makeCmd({ id: "b", label: "Show all saved" });
    expect(scoreCommand("sav", a)).toBeGreaterThan(scoreCommand("sav", b));
  });

  it("returns a low score for unrelated text", () => {
    const cmd = makeCmd({ label: "Satellite" });
    expect(scoreCommand("xyz", cmd)).toBeLessThan(SCORE_CUTOFF);
  });

  it("does not match unrelated long queries via accidental letter overlap", () => {
    // Regression: "university" used to score above the cutoff against
    // "Toggle overlay: Live Transit" via dice bigram overlap.
    const cmd = makeCmd({ label: "Toggle overlay: Live Transit" });
    expect(scoreCommand("university", cmd)).toBeLessThan(SCORE_CUTOFF);
  });

  it("matches multi-word queries with tokens split across the label", () => {
    // "overlay weather" is not a contiguous substring of the label
    // (a colon separates "overlay" and "Weather"), but both tokens appear.
    const cmd = makeCmd({ label: "Toggle overlay: Weather Overlay" });
    expect(scoreCommand("overlay weather", cmd)).toBeGreaterThan(SCORE_CUTOFF);
  });

  it("multi-word query requires all tokens to appear", () => {
    const cmd = makeCmd({ label: "Toggle overlay: Weather Overlay" });
    expect(scoreCommand("overlay xyz", cmd)).toBeLessThan(SCORE_CUTOFF);
  });

  it("ranks layers above overlays when both match by substring", () => {
    // Regression: typing "sat" should put "Map: Satellite" above
    // "Toggle overlay: NASA GIBS Satellite Imagery".
    const layer = makeCmd({ id: "layer", group: "layers", label: "Map: Satellite" });
    const overlay = makeCmd({
      id: "overlay",
      group: "overlays",
      label: "Toggle overlay: NASA GIBS Satellite Imagery",
    });
    expect(scoreCommand("sat", layer)).toBeGreaterThan(scoreCommand("sat", overlay));
  });
});
