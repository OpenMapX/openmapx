import type { HazardAlert, NaturalHazard } from "@openmapx/mobility-core/hazards";
import { describe, expect, it } from "vitest";
import { hazardToFeature as earthquakeFeature } from "../overlay-earthquakes/index";
import { alertToFeature } from "../overlay-weather-alerts/index";
import { hazardToFeature } from "./index";

const receipt = [
  { sourceId: "canonical-parent", name: "Captured publisher" },
  { sourceId: "canonical-parent", name: "Required notice" },
];
const hazard: NaturalHazard = {
  id: "a",
  type: "earthquake",
  geometry: { type: "Point", coordinates: [1, 2] },
  point: [1, 2],
  start: "2026-10-09T00:00:00Z",
  ended: false,
  sources: ["native-child"],
  attributions: [],
  contributors: receipt,
};
const alert: HazardAlert = {
  id: "a",
  type: "wind",
  geometry: hazard.geometry,
  event: "Wind",
  severity: "Severe",
  urgency: "Expected",
  certainty: "Likely",
  sent: "2026-10-09T00:00:00Z",
  sources: ["native-child"],
  attributions: [],
  notices: ["Required notice"],
  contributors: receipt,
};

describe("hazard route receipt preservation", () => {
  it("preserves the complete captured receipt through earthquake, natural event and alert conversion", () => {
    const quake = earthquakeFeature(hazard);
    const natural = hazardToFeature({ ...hazard, type: "volcano" });
    const warning = alertToFeature(alert);
    for (const feature of [quake, natural, warning]) {
      expect(feature?.properties).toMatchObject({
        sources: ["native-child"],
        contributors: receipt,
      });
    }
    receipt[0]!.name = "Changed catalogue";
    for (const feature of [quake, natural, warning])
      expect(
        (feature?.properties as { contributors?: { name: string }[] }).contributors?.[0]?.name,
      ).toBe("Captured publisher");
  });
});
