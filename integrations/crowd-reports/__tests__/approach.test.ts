import type { IncidentAlert } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { isCrowdIncident, selectCrowdApproach } from "../approach.js";

// Medium-severity approach window: leadSec 14, clamp [250, 1000] m.
function incident(
  id: string,
  alongMeters: number,
  origin: IncidentAlert["origin"] = "crowd",
): IncidentAlert {
  return {
    id,
    type: "traffic_incident",
    coord: [0, 0],
    alongMeters,
    kind: "incident",
    eventType: "obstruction",
    severity: "moderate",
    origin,
    headline: [{ lang: "en", text: "Hazard" }],
    closesRoad: false,
    geometry: { type: "Point", coordinates: [0, 0] },
    approach: { leadSec: 14, minM: 250, maxM: 1000 },
  };
}

describe("isCrowdIncident", () => {
  it("recognizes crowd reports by their origin, not their id", () => {
    expect(isCrowdIncident({ origin: "crowd" })).toBe(true);
    expect(isCrowdIncident({ origin: "feed" })).toBe(false);
    expect(isCrowdIncident({ origin: "federation" })).toBe(false);
    expect(isCrowdIncident({ origin: "derived" })).toBe(false);
  });
});

describe("selectCrowdApproach", () => {
  it("prompts on a crowd report within the speed-scaled window, ahead", () => {
    // along=0, speed=0 → window clamps to minM=250. 200 m ahead is inside it.
    const chosen = selectCrowdApproach([incident("near", 200)], 0, 0);
    expect(chosen?.id).toBe("near");
  });

  it("does NOT prompt on a crowd report beyond the window (no 25 km early fire)", () => {
    // 1500 m ahead > the 250 m window at rest → not yet in range.
    expect(selectCrowdApproach([incident("far", 1500)], 0, 0)).toBeNull();
  });

  it("widens the window with speed (leadSec·speed)", () => {
    // speed 30 m/s → window = 30·14 = 420 m (clamped within [250,1000]).
    expect(selectCrowdApproach([incident("x", 400)], 0, 30)?.id).toBe("x");
    expect(selectCrowdApproach([incident("x", 500)], 0, 30)).toBeNull();
  });

  it("ignores authoritative-feed incidents and reports behind the driver", () => {
    expect(selectCrowdApproach([incident("crowd:feed", 200, "feed")], 0, 0)).toBeNull();
    expect(selectCrowdApproach([incident("behind", 100)], 300, 0)).toBeNull();
  });

  it("suppresses dismissed ids", () => {
    const incidents = [incident("a", 200)];
    expect(selectCrowdApproach(incidents, 0, 0, ["a"])).toBeNull();
    expect(selectCrowdApproach(incidents, 0, 0, [])?.id).toBe("a");
  });
});
