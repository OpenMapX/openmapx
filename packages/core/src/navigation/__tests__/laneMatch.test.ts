import { describe, expect, it } from "vitest";
import type { ManeuverLane } from "../../types/routing";
import { matchLanes, normaliseIndication } from "../laneMatch";

const engine = (...lanes: string[][]): ManeuverLane[] =>
  lanes.map((indications) => ({ indications, valid: true }));
const general = (turn: string[] | null) => ({ kind: "general" as const, turn });
const cycle = { kind: "cycle" as const, turn: null };

describe("normaliseIndication", () => {
  it("reads engine and OSM spellings", () => {
    expect(normaliseIndication("slight right")).toBe("slight_right");
    expect(normaliseIndication("sharp_left")).toBe("sharp_left");
    expect(normaliseIndication("straight")).toBe("through");
    expect(normaliseIndication("uturn")).toBe("reverse");
    expect(normaliseIndication("")).toBe("none");
    expect(normaliseIndication("sideways")).toBeNull();
  });
});

describe("matchLanes", () => {
  it("agrees on identical lanes", () => {
    expect(
      matchLanes(engine(["left"], ["through", "right"]), [
        general(["left"]),
        general(["through", "right"]),
      ]),
    ).toEqual({ agree: true, engineToOsm: [0, 1] });
  });

  it("no engine lanes gives no agreement", () => {
    expect(matchLanes([], [general(["left"])])).toEqual({ agree: false, reason: "no-lanes" });
  });

  it("rejects a count mismatch", () => {
    expect(matchLanes(engine(["left"], ["through"]), [general(["left"])])).toEqual({
      agree: false,
      reason: "count",
    });
  });

  it("rejects a lane without turn values", () => {
    expect(matchLanes(engine(["left"], ["through"]), [general(["left"]), general(null)])).toEqual({
      agree: false,
      reason: "turn-missing",
    });
  });

  it("rejects different indications", () => {
    expect(
      matchLanes(engine(["left"], ["right"]), [general(["left"]), general(["through"])]),
    ).toEqual({ agree: false, reason: "indications" });
  });

  it("ignores cycle lanes", () => {
    expect(
      matchLanes(engine(["through"], ["right"]), [general(["through"]), general(["right"]), cycle]),
    ).toEqual({ agree: true, engineToOsm: [0, 1] });
  });

  it("treats an empty OSM value as none", () => {
    expect(matchLanes(engine(["none"], ["right"]), [general([]), general(["right"])]).agree).toBe(
      true,
    );
  });

  it("an unmarked OSM lane agrees with an engine through lane", () => {
    // Valhalla reads an unmarked lane as straight on (Spike B ruling, spec §4.3).
    expect(
      matchLanes(engine(["through"], ["through", "right"]), [
        general(["none"]),
        general(["through", "right"]),
      ]).agree,
    ).toBe(true);
    // Only that pairing: an unmarked lane does not match a turn.
    expect(matchLanes(engine(["left"]), [general(["none"])]).agree).toBe(false);
  });

  it("maps engine lane i to OSM lane i after cycle exclusion", () => {
    expect(
      matchLanes(engine(["left"], ["through"], ["right"]), [
        cycle,
        general(["left"]),
        { kind: "bus", turn: ["through"] },
        general(["right"]),
      ]),
    ).toEqual({ agree: true, engineToOsm: [1, 2, 3] });
  });
});
