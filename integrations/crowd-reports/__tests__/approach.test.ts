import type { IncidentAlert } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { isCrowdOriginId, selectCrowdApproach } from "../approach.js";

// Medium-severity approach window: leadSec 14, clamp [250, 1000] m.
function incident(id: string, alongMeters: number): IncidentAlert {
  return {
    id,
    type: "traffic_incident",
    coord: [0, 0],
    alongMeters,
    eventType: "hazard",
    severity: "medium",
    headline: "Hazard",
    approach: { leadSec: 14, minM: 250, maxM: 1000 },
  };
}

describe("isCrowdOriginId", () => {
  it("recognizes only the crowd: id convention", () => {
    expect(isCrowdOriginId("crowd:123")).toBe(true);
    expect(isCrowdOriginId("oc-crowd:abc")).toBe(false);
    expect(isCrowdOriginId("urn:openconditions:report:sig")).toBe(false);
    expect(isCrowdOriginId("datex:NL:456")).toBe(false);
  });
});

describe("selectCrowdApproach", () => {
  it("prompts on a crowd report within the speed-scaled window, ahead", () => {
    // along=0, speed=0 → window clamps to minM=250. 200 m ahead is inside it.
    const chosen = selectCrowdApproach([incident("crowd:near", 200)], 0, 0);
    expect(chosen?.id).toBe("crowd:near");
  });

  it("does NOT prompt on a crowd report beyond the window (no 25 km early fire)", () => {
    // 1500 m ahead > the 250 m window at rest → not yet in range.
    expect(selectCrowdApproach([incident("crowd:far", 1500)], 0, 0)).toBeNull();
  });

  it("widens the window with speed (leadSec·speed)", () => {
    // speed 30 m/s → window = 30·14 = 420 m (clamped within [250,1000]).
    expect(selectCrowdApproach([incident("crowd:x", 400)], 0, 30)?.id).toBe("crowd:x");
    expect(selectCrowdApproach([incident("crowd:x", 500)], 0, 30)).toBeNull();
  });

  it("ignores authoritative-feed incidents and reports behind the driver", () => {
    expect(selectCrowdApproach([incident("datex:1", 200)], 0, 0)).toBeNull();
    expect(selectCrowdApproach([incident("crowd:behind", 100)], 300, 0)).toBeNull();
  });

  it("suppresses dismissed ids", () => {
    const incidents = [incident("crowd:a", 200)];
    expect(selectCrowdApproach(incidents, 0, 0, ["crowd:a"])).toBeNull();
    expect(selectCrowdApproach(incidents, 0, 0, [])?.id).toBe("crowd:a");
  });
});
