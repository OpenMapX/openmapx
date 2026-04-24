import type { TransitStopInfrastructure } from "@openmapx/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StopInfrastructureSection } from "./StopInfrastructureSection";

const translations: Record<string, string> = {
  stationDetails: "Station details",
  complexitySimpleStop: "Simple stop",
  complexityInterchange: "Interchange",
  complexityMultimodalInterchange: "Multimodal interchange",
  complexityRegionalHub: "Regional hub",
  complexityRegionalMultimodalHub: "Regional multimodal hub",
  complexityMajorInterchange: "Major interchange",
  complexityMajorMultimodalInterchange: "Major multimodal interchange",
  area: "Area",
  accessibility: "Accessibility",
  amenities: "Amenities",
  parking: "Parking",
  parkingType: "Parking type",
  parkingTypeBike: "Bike parking",
  parkingTypeCar: "Car parking",
  parkingTypeParkRide: "Park & Ride",
  parkingTypeOther: "Parking",
  parkingLiveOccupancy: "Live occupancy",
  parkingDetails: "Parking details",
  parkingCapacityLabel: "Capacity",
  parkingFreeSpacesLabel: "Free spaces",
  parkingRealtimeLabel: "Live occupancy",
  fareZones: "Fare zones",
  fareZoneGeneralNote: "Fares usually depend on the zones your trip passes through.",
  fareZoneBoundaryNote: "Crossing into another zone can change the fare for your trip.",
  stationFacts: "Station facts",
  childStopAreas: "Child stop areas",
  relatedStopAreas: "Related stop areas",
  openBoard: "Board",
  focusedArea: "Focused area",
  platforms: "Platforms",
  platform: "Platform",
  boardingPositions: "Boarding positions",
  showOnMap: "Show on map",
  revealOnMap: "Reveal on map",
  deprecatedFareZone: "Legacy tariff zone",
  stopType: "Stop type",
  weighting: "Weighting",
  parentStation: "Parent station",
  topographicPlace: "Topographic place",
  available: "Available",
  yes: "Yes",
  no: "No",
  rail: "Rail",
  subway: "Subway",
  trams: "Trams",
  buses: "Buses",
  ferries: "Ferries",
  gondola: "Gondola",
  funicular: "Funicular",
  cableCar: "Cable car",
  monorail: "Monorail",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    switch (key) {
      case "stationSummaryChildStops":
        return `${String(values?.count ?? 0)} child stop areas`;
      case "stationSummaryConnectedStops":
        return `${String(values?.count ?? 0)} stop areas in complex`;
      case "stationSummaryPlatforms":
        return `${String(values?.count ?? 0)} platforms`;
      case "stationSummaryAttachedParking":
        return "attached parking";
      case "stationSummaryLiveParking":
        return "live parking";
      case "parkingCapacity":
        return `${String(values?.count ?? 0)} spaces`;
      case "parkingFreeSpaces":
        return `${String(values?.count ?? 0)} free`;
      case "fareZoneSingleAuthoritySummary":
        return `This stop is in ${String(values?.authority ?? "")} zone ${String(values?.zone ?? "")}.`;
      case "fareZoneSingleSummary":
        return `This stop is in zone ${String(values?.zone ?? "")}.`;
      case "fareZoneMultipleAuthoritySummary":
        return `This stop sits across ${String(values?.count ?? 0)} ${String(values?.authority ?? "")} fare zones.`;
      case "fareZoneMultipleNetworkSummary":
        return `This stop connects ${String(values?.zoneCount ?? 0)} fare zones across ${String(values?.authorityCount ?? 0)} authorities.`;
      default:
        return translations[key] ?? key;
    }
  },
}));

vi.mock("@/lib/theme", () => ({
  TEAL: "#0f9d58",
}));

const parentInfrastructure: TransitStopInfrastructure = {
  stopId: "entur:NSR:StopPlace:59872",
  provider: "entur",
  sourceId: "NSR:StopPlace:59872",
  displayName: "Oslo S",
  focusLevel: "parent_stop",
  requestedStop: {
    id: "entur:NSR:StopPlace:59872",
    name: "Oslo S",
    lat: 59.91,
    lng: 10.75,
    modes: ["rail", "subway"],
    level: "parent_stop",
  },
  canonicalStop: {
    id: "entur:NSR:StopPlace:59872",
    name: "Oslo S",
    lat: 59.91,
    lng: 10.75,
    modes: ["rail", "subway"],
    level: "parent_stop",
  },
  siblingStops: [],
  childStops: [
    {
      id: "entur:NSR:StopPlace:337",
      name: "Oslo S rail",
      lat: 59.91,
      lng: 10.75,
      modes: ["rail"],
      level: "child_stop",
      parentStopId: "entur:NSR:StopPlace:59872",
    },
    {
      id: "entur:NSR:StopPlace:4067",
      name: "Oslo S metro",
      lat: 59.911,
      lng: 10.752,
      modes: ["subway"],
      level: "child_stop",
      parentStopId: "entur:NSR:StopPlace:59872",
    },
  ],
  platforms: [
    {
      id: "entur:NSR:Quay:571",
      name: "Oslo S rail",
      lat: 59.9111,
      lng: 10.755,
      modes: ["rail"],
      parentStopId: "entur:NSR:StopPlace:337",
      publicCode: "11",
    },
    {
      id: "entur:NSR:Quay:7333",
      name: "Oslo S metro",
      lat: 59.9115,
      lng: 10.7529,
      modes: ["subway"],
      parentStopId: "entur:NSR:StopPlace:4067",
      publicCode: "1",
      boardingPositions: ["A", "B"],
    },
  ],
  accessibility: [],
  amenities: [],
  fareZones: [
    {
      id: "entur:NSR:FareZone:1",
      name: "Zone 1",
      authorityName: "Ruter",
      privateCode: "1",
      hasGeometry: true,
    },
  ],
  facts: [],
  stationIntelligence: {
    complexity: "major_interchange",
    modeCount: 2,
    hasParking: true,
    hasRealtimeParking: true,
  },
  parking: [
    {
      id: "NSR:Parking:oslo-s-pr",
      name: "P+R Oslo S",
      lat: 59.9104,
      lng: 10.7542,
      kind: "park_and_ride",
      vehicleTypes: ["CAR"],
      capacity: 180,
      freeSpaces: 42,
      hasRealtimeData: true,
    },
  ],
  geometry: {
    stopArea: {
      type: "Polygon",
      coordinates: [
        [
          [10.744, 59.909],
          [10.756, 59.909],
          [10.756, 59.916],
          [10.744, 59.916],
          [10.744, 59.909],
        ],
      ],
    },
    fareZones: [
      {
        fareZoneId: "entur:NSR:FareZone:1",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [10.73, 59.9],
              [10.77, 59.9],
              [10.77, 59.93],
              [10.73, 59.93],
              [10.73, 59.9],
            ],
          ],
        },
      },
    ],
  },
};

const childInfrastructure: TransitStopInfrastructure = {
  ...parentInfrastructure,
  focusLevel: "child_stop",
  requestedStop: {
    id: "entur:NSR:StopPlace:337",
    name: "Oslo S rail",
    lat: 59.91,
    lng: 10.75,
    modes: ["rail"],
    level: "child_stop",
    parentStopId: "entur:NSR:StopPlace:59872",
  },
  canonicalStop: {
    id: "entur:NSR:StopPlace:337",
    name: "Oslo S rail",
    lat: 59.91,
    lng: 10.75,
    modes: ["rail"],
    level: "child_stop",
    parentStopId: "entur:NSR:StopPlace:59872",
  },
  parentStop: {
    id: "entur:NSR:StopPlace:59872",
    name: "Oslo S",
    lat: 59.91,
    lng: 10.75,
    modes: ["rail", "subway"],
    level: "parent_stop",
  },
  childStops: [],
  siblingStops: [
    {
      id: "entur:NSR:StopPlace:4067",
      name: "Oslo S metro",
      lat: 59.911,
      lng: 10.752,
      modes: ["subway"],
      level: "child_stop",
      parentStopId: "entur:NSR:StopPlace:59872",
    },
  ],
  platforms: [
    {
      id: "entur:NSR:Quay:571",
      name: "Oslo S rail",
      lat: 59.9111,
      lng: 10.755,
      modes: ["rail"],
      parentStopId: "entur:NSR:StopPlace:337",
      publicCode: "11",
    },
  ],
};

let currentInfrastructure: TransitStopInfrastructure = parentInfrastructure;
const focusTransitMapFeature = vi.fn();
const setSelectedPlace = vi.fn();
const placeStoreState = {
  transitMapFocus: null as { kind: string; id: string } | null,
  focusTransitMapFeature,
  setSelectedPlace,
};

vi.mock("@openmapx/core", () => ({
  PANEL: { PLACE_CARD: "place-card" },
  usePlaceStopInfrastructure: () => ({
    data: currentInfrastructure,
    isLoading: false,
    resolvedStopId: currentInfrastructure.stopId,
  }),
  usePlaceStore: (selector: (state: typeof placeStoreState) => unknown) =>
    selector(placeStoreState),
  useSidebarStore: { getState: () => ({ openDetail: vi.fn() }) },
  withId: <T extends { primaryScheme: string; ids: Record<string, string> }>(item: T) => ({
    ...item,
    id: `${item.primaryScheme}:${item.ids[item.primaryScheme]}`,
  }),
}));

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ flyTo: vi.fn() }),
}));

vi.mock("../shared/StructuredSections", () => ({
  StructuredSections: ({
    sections,
  }: {
    sections: Array<{
      title: string;
      rows?: Array<Array<string | number>>;
      items?: string[];
    }>;
  }) => (
    <div>
      {sections.map((section) => (
        <section key={section.title}>
          <h3>{section.title}</h3>
          {(section.rows ?? []).map((row) => (
            <div key={`${section.title}-${row.join("-")}`}>{row.join(" :: ")}</div>
          ))}
          {(section.items ?? []).map((item) => (
            <div key={`${section.title}-${item}`}>{item}</div>
          ))}
        </section>
      ))}
    </div>
  ),
}));

describe("StopInfrastructureSection", () => {
  it("renders grouped parent-station platforms and child stop areas", () => {
    currentInfrastructure = parentInfrastructure;
    placeStoreState.transitMapFocus = null;
    const markup = renderToStaticMarkup(
      <StopInfrastructureSection place={{ id: "place-1" } as never} onOpenStopBoard={() => {}} />,
    );

    expect(markup).toContain("Station details");
    expect(markup).toContain("Reveal on map");
    expect(markup).toContain("Child stop areas");
    expect(markup).toContain("Major multimodal interchange");
    expect(markup).toContain("2 child stop areas");
    expect(markup).toContain("2 platforms");
    expect(markup).toContain("live parking");
    expect(markup).toContain("Oslo S rail");
    expect(markup).toContain("Oslo S metro");
    expect(markup).toContain("Platform 11");
    expect(markup).toContain("Platform 1");
    expect(markup).toContain("Boarding positions: A, B");
    expect(markup).toContain("P+R Oslo S");
    expect(markup).toContain("180 spaces");
    expect(markup).toContain("42 free");
    expect(markup).toContain("Live occupancy");
    expect(markup).toContain("Parking details");
    expect(markup).toContain("This stop is in Ruter zone 1.");
    expect(markup).toContain("Fares usually depend on the zones your trip passes through.");
    expect(markup).toContain("Show on map");
    expect(markup).toContain("Board");
  });

  it("renders child-stop sibling context with a focused-area label", () => {
    currentInfrastructure = childInfrastructure;
    placeStoreState.transitMapFocus = null;
    const markup = renderToStaticMarkup(
      <StopInfrastructureSection place={{ id: "place-2" } as never} onOpenStopBoard={() => {}} />,
    );

    expect(markup).toContain("Related stop areas");
    expect(markup).toContain("Focused area");
    expect(markup).toContain("Oslo S metro");
    expect(markup).toContain("Platform 11");
  });
});
