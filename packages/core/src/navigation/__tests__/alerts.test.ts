import { describe, expect, it } from "vitest";
import { type RoadAlert, selectActiveAlert, shouldWarnCamera } from "../alerts";

const cam: RoadAlert = {
  id: "c1",
  type: "speed_camera",
  coord: [0, 0],
  alongMeters: 1100,
  speedLimitKmh: 50,
};
const calming: RoadAlert = { id: "t1", type: "traffic_calming", coord: [0, 0], alongMeters: 1050 };

describe("selectActiveAlert", () => {
  it("returns null when nothing is ahead in range", () => {
    expect(selectActiveAlert([cam], 1200, 14, [])).toBeNull(); // behind us
    expect(selectActiveAlert([cam], 0, 14, [])).toBeNull(); // still too far away
  });

  it("prefers the higher-priority alert when several are in range", () => {
    const a = selectActiveAlert([calming, cam], 1000, 14, []);
    expect(a?.alert.id).toBe("c1"); // camera outranks traffic calming
  });

  it("skips already-announced alerts", () => {
    expect(selectActiveAlert([cam], 1000, 14, ["c1"])).toBeNull();
  });

  it("falls back to the next alert once the first is announced", () => {
    const a = selectActiveAlert([calming, cam], 1000, 14, ["c1"]);
    expect(a?.alert.id).toBe("t1");
  });
});

describe("shouldWarnCamera", () => {
  it("warns when you can't slow to the limit in the remaining distance", () => {
    expect(shouldWarnCamera(30, 50, 40)).toBe(true);
  });

  it("does not warn when there is room to slow down", () => {
    expect(shouldWarnCamera(30, 50, 200)).toBe(false);
  });

  it("always warns when the camera limit is unknown", () => {
    expect(shouldWarnCamera(20, undefined, 100)).toBe(true);
  });
});
