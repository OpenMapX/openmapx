import { describe, expect, it } from "vitest";
import type { RouteStep } from "../../types/routing";
import type { VoiceScheduleConfig } from "../types";
import { nextVoiceCue } from "../voiceCue";

const step = {
  instruction: "Turn right",
  distance: 500,
  duration: 60,
  coordinates: [],
} as RouteStep;

const config: VoiceScheduleConfig = {
  farMeters: 400,
  nearMeters: 200,
  refSpeedMps: 14,
  nowSeconds: 2.5,
  nowFloorMeters: 30,
  ttsDelaySeconds: 1.5,
};

// At the reference speed (14 m/s) with multiplier 1:
//   far ≈ 400 + 14·1.5 = 421 m, near ≈ 221 m, now ≈ max(30, 35) + 21 = 56 m.
const REF = 14;

describe("nextVoiceCue", () => {
  it("returns no cue when beyond the far trigger", () => {
    expect(nextVoiceCue(step, 0, 800, REF, config, 1, [])).toBeNull();
  });

  it("returns the 'far' tier once on first crossing", () => {
    const cue = nextVoiceCue(step, 0, 400, REF, config, 1, []);
    expect(cue?.tier).toBe("far");
    expect(cue?.key).toBe("0:far");
  });

  it("does not repeat an already-spoken tier", () => {
    expect(nextVoiceCue(step, 0, 400, REF, config, 1, ["0:far"])).toBeNull();
  });

  it("escalates to 'now' close to the maneuver", () => {
    const cue = nextVoiceCue(step, 0, 20, REF, config, 1, ["0:far", "0:near"]);
    expect(cue?.tier).toBe("now");
  });

  it("triggers earlier at higher speed (speed-adaptive)", () => {
    // 700 m out: not yet 'far' at city speed, but already 'far' on a motorway.
    expect(nextVoiceCue(step, 0, 700, REF, config, 1, [])).toBeNull();
    expect(nextVoiceCue(step, 0, 700, 40, config, 1, [])?.tier).toBe("far");
  });

  it("shifts triggers earlier with a larger announcement multiplier", () => {
    // 600 m out at city speed: silent at 1.0×, but 'far' at 1.5× (early).
    expect(nextVoiceCue(step, 0, 600, REF, config, 1, [])).toBeNull();
    expect(nextVoiceCue(step, 0, 600, REF, config, 1.5, [])?.tier).toBe("far");
  });

  it("keeps a sane minimum lead when stopped (effective speed floored at ref)", () => {
    // Speed 0 → far trigger collapses to farMeters (no latency term).
    expect(nextVoiceCue(step, 0, 401, 0, config, 1, [])).toBeNull();
    expect(nextVoiceCue(step, 0, 399, 0, config, 1, [])?.tier).toBe("far");
  });
});
