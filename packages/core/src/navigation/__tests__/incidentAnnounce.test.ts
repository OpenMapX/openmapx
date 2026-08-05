import { describe, expect, it } from "vitest";
import { formatIncidentAnnouncement } from "../incidentAnnounce";

// A stub translator that renders the catalog templates this formatter targets.
const t = (key: string, values?: Record<string, string>): string => {
  const types: Record<string, string> = {
    "incidentType.roadworks": "Roadworks",
    "incidentType.road_closure": "Road closure",
    "incidentType.accident": "Accident",
  };
  if (key in types) return types[key];
  if (key === "incidentAhead") return `${values?.type} ahead in ${values?.distance}`;
  if (key === "incidentRoadClosed") return "— road closed";
  return key;
};

describe("formatIncidentAnnouncement", () => {
  it("phrases a roadworks incident with type + distance", () => {
    expect(formatIncidentAnnouncement({ eventType: "roadworks" }, "800 m", t)).toBe(
      "Roadworks ahead in 800 m",
    );
  });

  it("appends a closed-road clause for closures", () => {
    expect(formatIncidentAnnouncement({ eventType: "road_closure" }, "1.2 km", t)).toBe(
      "Road closure ahead in 1.2 km — road closed",
    );
  });

  it("does not append the clause for non-closures", () => {
    expect(formatIncidentAnnouncement({ eventType: "accident" }, "500 m", t)).toBe(
      "Accident ahead in 500 m",
    );
  });
});
