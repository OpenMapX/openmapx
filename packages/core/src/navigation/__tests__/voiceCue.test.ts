import type { RouteStep } from "@integrations/routing/types";
import { describe, expect, it } from "vitest";
import { nextVoiceCue } from "../voiceCue";

const step = {
  instruction: "Turn right",
  distance: 500,
  duration: 60,
  coordinates: [],
} as RouteStep;
const thresholds = { far: 400, near: 200 };

describe("nextVoiceCue", () => {
  it("returns no cue when beyond the far threshold", () => {
    expect(nextVoiceCue(step, 0, 800, thresholds, [])).toBeNull();
  });

  it("returns the 'far' tier once on first crossing", () => {
    const cue = nextVoiceCue(step, 0, 350, thresholds, []);
    expect(cue?.tier).toBe("far");
    expect(cue?.key).toBe("0:far");
  });

  it("does not repeat an already-spoken tier", () => {
    expect(nextVoiceCue(step, 0, 350, thresholds, ["0:far"])).toBeNull();
  });

  it("escalates to 'now' under 30 m", () => {
    const cue = nextVoiceCue(step, 0, 20, thresholds, ["0:far", "0:near"]);
    expect(cue?.tier).toBe("now");
  });
});
