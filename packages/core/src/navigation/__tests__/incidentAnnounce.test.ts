import { describe, expect, it } from "vitest";
import { formatIncidentAnnouncement, incidentTypeLabelKey } from "../incidentAnnounce";

// A stub translator that renders the catalog templates this formatter targets.
const t = (key: string, values?: Record<string, string>): string => {
  const types: Record<string, string> = {
    "incidentType.works": "Roadworks",
    "incidentType.closure": "Road closure",
    "incidentType.accident": "Accident",
    "incidentType.other": "Incident",
  };
  if (key in types) return types[key];
  if (key === "incidentAhead") return `${values?.type} ahead in ${values?.distance}`;
  if (key === "incidentRoadClosed") return "— road closed";
  return key;
};

describe("formatIncidentAnnouncement", () => {
  it("phrases a roadworks incident with type + distance", () => {
    expect(formatIncidentAnnouncement({ eventType: "works", closesRoad: false }, "800 m", t)).toBe(
      "Roadworks ahead in 800 m",
    );
  });

  it("appends a closed-road clause for a situation that closes the road", () => {
    expect(
      formatIncidentAnnouncement({ eventType: "closure", closesRoad: true }, "1.2 km", t),
    ).toBe("Road closure ahead in 1.2 km — road closed");
    // The clause follows the effect, not the type: works that close the road say so.
    expect(formatIncidentAnnouncement({ eventType: "works", closesRoad: true }, "1 km", t)).toBe(
      "Roadworks ahead in 1 km — road closed",
    );
  });

  it("does not append the clause for non-closures", () => {
    expect(
      formatIncidentAnnouncement({ eventType: "accident", closesRoad: false }, "500 m", t),
    ).toBe("Accident ahead in 500 m");
  });

  it("names a type outside the catalog as a generic incident", () => {
    expect(incidentTypeLabelKey({ eventType: "teleporter" })).toBe("incidentType.other");
    expect(
      formatIncidentAnnouncement({ eventType: "teleporter", closesRoad: false }, "2 km", t),
    ).toBe("Incident ahead in 2 km");
  });
});
