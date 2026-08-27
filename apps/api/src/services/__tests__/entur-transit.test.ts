import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamedJsonResponse } from "../../test/streamed-response.js";

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@openmapx/core");
  return {
    ...actual,
    decodePolyline: (_encoded: string) => [
      [10.728, 59.915],
      [10.753, 59.911],
      [10.77, 59.905],
    ],
  };
});

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  return streamedJsonResponse(data);
}

function nsrPolygon(...coordinates: number[]) {
  return {
    exterior: {
      abstractRing: {
        type: "LinearRing",
        value: {
          posList: {
            value: coordinates,
          },
        },
      },
    },
    id: "test-polygon",
  };
}

async function loadModule() {
  vi.resetModules();
  const mod = await import("@integrations/transit-entur/provider.js");
  mod.setEnturTransitConfig({
    geocoderEndpoint: "https://api.entur.io/geocoder/v1",
    journeyPlannerEndpoint: "https://api.entur.io/journey-planner/v3/graphql",
    vehiclesEndpoint: "https://api.entur.io/realtime/v2/vehicles/graphql",
    nsrEndpoint: "https://api.entur.io/stop-places/v1/read",
    clientName: "openmapx-tests",
    boundaryCountry: "NOR",
    multiModal: "parent",
  });
  return mod;
}

describe("Entur transit stop discovery", () => {
  it("maps nearby stop places to Entur transit stops with NSR identities", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          nearest: {
            edges: [
              {
                node: {
                  place: {
                    __typename: "StopPlace",
                    id: "NSR:StopPlace:288",
                    name: "Nationaltheatret stasjon",
                    latitude: 59.91539,
                    longitude: 10.728133,
                    transportMode: ["rail", "metro"],
                    transportSubmode: ["unknown"],
                  },
                },
              },
            ],
          },
        },
      }),
    );

    const { getStopsNearby } = await loadModule();
    const stops = await getStopsNearby(59.915, 10.728, 500);

    expect(stops).toEqual([
      {
        id: "entur:NSR:StopPlace:288",
        primaryScheme: "nsr",
        ids: {
          entur: "NSR:StopPlace:288",
          nsr: "StopPlace:288",
        },
        codes: [{ namespace: "nsr", value: "NSR:StopPlace:288" }],
        name: "Nationaltheatret stasjon",
        lat: 59.91539,
        lng: 10.728133,
        modes: ["rail", "subway"],
        provider: "entur",
      },
    ]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.entur.io/journey-planner/v3/graphql");
    expect((init.headers as Record<string, string>)["ET-Client-Name"]).toBe("openmapx-tests");
  });

  it("uses the Entur geocoder for stop-name search and keeps NSR ids", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { coordinates: [10.753051, 59.910357] },
            properties: {
              id: "NSR:StopPlace:59872",
              source_id: "NSR:StopPlace:59872",
              layer: "venue",
              name: "Oslo S",
              category: ["railStation", "onstreetBus"],
              mode: [{ rail: null }, { bus: null }],
            },
          },
        ],
      }),
    );

    const { searchByName } = await loadModule();
    const stops = await searchByName("Oslo S", 5);

    expect(stops).toEqual([
      {
        id: "entur:NSR:StopPlace:59872",
        primaryScheme: "nsr",
        ids: {
          entur: "NSR:StopPlace:59872",
          nsr: "StopPlace:59872",
        },
        codes: [{ namespace: "nsr", value: "NSR:StopPlace:59872" }],
        name: "Oslo S",
        lat: 59.910357,
        lng: 10.753051,
        modes: ["rail", "bus"],
        provider: "entur",
      },
    ]);

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/geocoder/v1/autocomplete");
    expect(parsed.searchParams.get("boundary.country")).toBe("NOR");
    expect(parsed.searchParams.get("multiModal")).toBe("parent");
  });
});

describe("Entur boards and trip planning", () => {
  it("maps estimated calls to departures with encoded service-journey ids", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          stopPlace: {
            situations: [],
            estimatedCalls: [
              {
                aimedDepartureTime: "2026-04-21T22:04:00+02:00",
                expectedDepartureTime: "2026-04-21T22:06:00+02:00",
                aimedArrivalTime: "2026-04-21T22:01:00+02:00",
                expectedArrivalTime: "2026-04-21T22:03:00+02:00",
                occupancyStatus: "standingAvailable",
                cancellation: false,
                destinationDisplay: { frontText: "Kongsvinger" },
                quay: {
                  id: "NSR:Quay:571",
                  publicCode: "11",
                  stopPlace: {
                    id: "NSR:StopPlace:337",
                    name: "Oslo S",
                    latitude: 59.910925,
                    longitude: 10.753276,
                    transportMode: ["rail"],
                    transportSubmode: ["unknown"],
                  },
                },
                serviceJourney: {
                  id: "VYG:ServiceJourney:1035_442947-R",
                  line: {
                    id: "VYG:Line:R14",
                    publicCode: "R14",
                    name: "Asker-Oslo S-Kongsvinger",
                    transportMode: "rail",
                    transportSubmode: "unknown",
                    authority: { id: "VYG:Authority:VY", name: "Vy" },
                    operator: { id: "VYG:Operator:VY", name: "VY" },
                    presentation: { colour: "DF2027", textColour: "FFFFFF" },
                  },
                },
                situations: [],
              },
            ],
          },
        },
      }),
    );

    const { getDepartures } = await loadModule();
    const departures = await getDepartures("entur:NSR:StopPlace:337", 60);

    expect(departures).toEqual([
      {
        tripId: "entur:2026-04-21|VYG:ServiceJourney:1035_442947-R",
        route: {
          id: "entur:VYG:Line:R14",
          shortName: "R14",
          longName: "Asker-Oslo S-Kongsvinger",
          mode: "rail",
          color: "DF2027",
        },
        headsign: "Kongsvinger",
        scheduledAt: "2026-04-21T22:04:00+02:00",
        expectedAt: "2026-04-21T22:06:00+02:00",
        delaySeconds: 120,
        platform: "11",
        canceled: false,
        occupancy: "medium",
        remarks: undefined,
      },
    ]);
  });

  it("maps Journey Planner trip patterns to itinerary legs with route and trip ids", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          trip: {
            fromPlace: {
              name: "Nationaltheatret stasjon",
              latitude: 59.915362,
              longitude: 10.727551,
            },
            toPlace: {
              name: "Oslo S",
              latitude: 59.9104,
              longitude: 10.754999,
            },
            tripPatterns: [
              {
                expectedStartTime: "2026-04-21T22:08:16+02:00",
                expectedEndTime: "2026-04-21T22:11:00+02:00",
                duration: 164,
                streetDistance: 0,
                walkTime: 0,
                distance: 1646.89,
                emission: { co2: 43.151 },
                legs: [
                  {
                    id: "leg-1",
                    mode: "rail",
                    transportSubmode: "local",
                    realtime: true,
                    ride: true,
                    expectedStartTime: "2026-04-21T22:08:16+02:00",
                    expectedEndTime: "2026-04-21T22:11:00+02:00",
                    distance: 1646.89,
                    serviceDate: "2026-04-21",
                    fromPlace: {
                      name: "Nationaltheatret stasjon",
                      latitude: 59.915362,
                      longitude: 10.727551,
                      quay: {
                        id: "NSR:Quay:477",
                        publicCode: "3",
                        stopPlace: {
                          id: "NSR:StopPlace:288",
                          name: "Nationaltheatret stasjon",
                          latitude: 59.91539,
                          longitude: 10.728133,
                        },
                      },
                    },
                    toPlace: {
                      name: "Oslo S",
                      latitude: 59.9104,
                      longitude: 10.754999,
                      quay: {
                        id: "NSR:Quay:571",
                        publicCode: "11",
                        stopPlace: {
                          id: "NSR:StopPlace:337",
                          name: "Oslo S",
                          latitude: 59.910925,
                          longitude: 10.753276,
                        },
                      },
                    },
                    fromEstimatedCall: {
                      occupancyStatus: "manySeatsAvailable",
                    },
                    toEstimatedCall: {
                      occupancyStatus: "manySeatsAvailable",
                    },
                    line: {
                      id: "VYG:Line:R13",
                      publicCode: "R13",
                      name: "Drammen-Oslo S-Dal",
                      transportMode: "rail",
                      transportSubmode: "unknown",
                      authority: { id: "VYG:Authority:VY", name: "Vy" },
                      operator: { id: "VYG:Operator:VY", name: "VY" },
                      presentation: { colour: "DF2027", textColour: "FFFFFF" },
                    },
                    serviceJourney: {
                      id: "VYG:ServiceJourney:1669_443361-R",
                      publicCode: null,
                    },
                    pointsOnLink: { points: "encoded" },
                    intermediateEstimatedCalls: [],
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const { planTrip } = await loadModule();
    const plan = await planTrip({
      from: { lat: 59.915, lng: 10.728 },
      to: { lat: 59.911, lng: 10.753 },
      departureTime: "2026-04-21T20:00:00Z",
    });

    expect(plan).not.toBeNull();
    expect(plan?.provider).toBe("entur");
    expect(plan?.itineraries).toHaveLength(1);
    expect(plan?.itineraries[0]).toMatchObject({
      duration: 164,
      walkDistance: 0,
      transfers: 0,
      co2Grams: 43.151,
    });
    expect(plan?.itineraries[0].legs[0]).toMatchObject({
      mode: "rail",
      tripId: "entur:2026-04-21|VYG:ServiceJourney:1669_443361-R",
      routeId: "entur:VYG:Line:R13",
      occupancy: "low",
    });
    expect(plan?.itineraries[0].legs[0].geometry.coordinates).toEqual([
      [10.728, 59.915],
      [10.753, 59.911],
      [10.77, 59.905],
    ]);
  });
});

describe("Entur route, vehicles, journey, and facilities", () => {
  it("maps line detail to a transit route with decoded geometry", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          line: {
            id: "VYG:Line:R14",
            publicCode: "R14",
            name: "Asker-Oslo S-Kongsvinger",
            transportMode: "rail",
            transportSubmode: "unknown",
            authority: { id: "VYG:Authority:VY", name: "Vy" },
            operator: { id: "VYG:Operator:VY", name: "VY" },
            presentation: { colour: "DF2027", textColour: "FFFFFF" },
            journeyPatterns: [
              {
                id: "VYG:JourneyPattern:R14-1061",
                name: "ASR-KVG",
                directionType: "unknown",
                pointsOnLink: { points: "encoded" },
                quays: [],
              },
            ],
            situations: [],
          },
        },
      }),
    );

    const { getRoute } = await loadModule();
    const route = await getRoute("entur:VYG:Line:R14");

    expect(route).toEqual({
      id: "entur:VYG:Line:R14",
      shortName: "R14",
      longName: "Asker-Oslo S-Kongsvinger",
      mode: "rail",
      color: "DF2027",
      textColor: "FFFFFF",
      operatorName: "VY",
      geometry: {
        type: "LineString",
        coordinates: [
          [10.728, 59.915],
          [10.753, 59.911],
          [10.77, 59.905],
        ],
      },
    });
  });

  it("maps route stop sequences as one-based values", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          line: {
            id: "VYG:Line:R14",
            publicCode: "R14",
            name: "Asker-Oslo S-Kongsvinger",
            transportMode: "rail",
            transportSubmode: "unknown",
            journeyPatterns: [
              {
                id: "VYG:JourneyPattern:R14-1061",
                name: "ASR-KVG",
                directionType: "unknown",
                pointsOnLink: { points: "encoded" },
                quays: [
                  {
                    id: "NSR:Quay:477",
                    name: "Nationaltheatret",
                    publicCode: "3",
                    latitude: 59.915362,
                    longitude: 10.727551,
                    stopPlace: {
                      id: "NSR:StopPlace:288",
                      name: "Nationaltheatret stasjon",
                      latitude: 59.91539,
                      longitude: 10.728133,
                    },
                  },
                  {
                    id: "NSR:Quay:571",
                    name: "Oslo S",
                    publicCode: "11",
                    latitude: 59.9104,
                    longitude: 10.754999,
                    stopPlace: {
                      id: "NSR:StopPlace:337",
                      name: "Oslo S",
                      latitude: 59.910925,
                      longitude: 10.753276,
                    },
                  },
                ],
              },
            ],
            situations: [],
          },
        },
      }),
    );

    const { getRouteStops } = await loadModule();
    const stops = await getRouteStops("entur:VYG:Line:R14");

    expect(stops.map((stop) => stop.sequence)).toEqual([1, 2]);
    expect(stops[0]).toMatchObject({
      id: "entur:NSR:StopPlace:288",
      name: "Nationaltheatret stasjon",
      platformCode: "3",
    });
  });

  it("maps live vehicles to route and trip scoped vehicle positions", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          vehicles: [
            {
              vehicleId: "1035-2026-04-21",
              lastUpdated: "2026-04-21T20:05:19.286Z",
              bearing: 91.5,
              speed: 23.4,
              delay: 0,
              monitored: true,
              mode: "RAIL",
              occupancyStatus: "manySeatsAvailable",
              vehicleStatus: "IN_PROGRESS",
              line: {
                lineRef: "VYG:Line:R14",
                lineName: "Asker-Oslo S-Kongsvinger",
                publicCode: "R14",
              },
              serviceJourney: {
                id: "VYG:ServiceJourney:1035_442947-R",
                date: "2026-04-21",
              },
              operator: {
                operatorRef: "VYG:Operator:VY",
                name: "VY",
              },
              codespace: {
                codespaceId: "VYG",
              },
              location: {
                latitude: 59.919183,
                longitude: 10.692515,
              },
              monitoredCall: {
                stopPointRef: "NSR:ScheduledStopPoint:1",
                order: 6,
                vehicleAtStop: false,
              },
            },
          ],
        },
      }),
    );

    const { getVehiclePositions } = await loadModule();
    const vehicles = await getVehiclePositions("entur:VYG:Line:R14");

    expect(vehicles).toEqual([
      {
        id: "entur:vehicle:1035-2026-04-21",
        provider: "entur",
        tripId: "entur:2026-04-21|VYG:ServiceJourney:1035_442947-R",
        routeId: "entur:VYG:Line:R14",
        lat: 59.919183,
        lng: 10.692515,
        bearing: 91.5,
        speed: 23.4,
        label: "1035-2026-04-21",
        currentStopId: "entur:NSR:ScheduledStopPoint:1",
        currentStopSequence: 6,
        updatedAt: "2026-04-21T20:05:19.286Z",
      },
    ]);
  });

  it("maps service journeys to trip-detail stop sequences", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: {
          serviceJourney: {
            id: "VYG:ServiceJourney:1035_442947-R",
            publicCode: null,
            transportMode: "rail",
            transportSubmode: "local",
            pointsOnLink: { points: "encoded" },
            situations: [],
            line: {
              id: "VYG:Line:R14",
              publicCode: "R14",
              name: "Asker-Oslo S-Kongsvinger",
              transportMode: "rail",
              transportSubmode: "unknown",
              authority: { id: "VYG:Authority:VY", name: "Vy" },
              operator: { id: "VYG:Operator:VY", name: "VY" },
              presentation: { colour: "DF2027", textColour: "FFFFFF" },
            },
            journeyPattern: {
              id: "VYG:JourneyPattern:R14-1061",
              name: "ASR-KVG",
              pointsOnLink: { points: "encoded" },
              quays: [],
            },
            quays: [],
            estimatedCalls: [
              {
                quay: {
                  id: "NSR:Quay:477",
                  name: "Nationaltheatret stasjon",
                  publicCode: "3",
                  latitude: 59.915362,
                  longitude: 10.727551,
                  stopPlace: {
                    id: "NSR:StopPlace:288",
                    name: "Nationaltheatret stasjon",
                    latitude: 59.91539,
                    longitude: 10.728133,
                  },
                },
                aimedArrivalTime: "2026-04-21T21:57:00+02:00",
                expectedArrivalTime: "2026-04-21T21:56:32+02:00",
                actualArrivalTime: "2026-04-21T21:56:32+02:00",
                aimedDepartureTime: "2026-04-21T21:58:00+02:00",
                expectedDepartureTime: "2026-04-21T21:59:02+02:00",
                actualDepartureTime: "2026-04-21T21:59:02+02:00",
                occupancyStatus: "manySeatsAvailable",
                cancellation: false,
                forBoarding: true,
                forAlighting: true,
                situations: [],
              },
              {
                quay: {
                  id: "NSR:Quay:571",
                  name: "Oslo S",
                  publicCode: "11",
                  latitude: 59.9104,
                  longitude: 10.754999,
                  stopPlace: {
                    id: "NSR:StopPlace:337",
                    name: "Oslo S",
                    latitude: 59.910925,
                    longitude: 10.753276,
                  },
                },
                aimedArrivalTime: "2026-04-21T22:01:00+02:00",
                expectedArrivalTime: "2026-04-21T21:59:59+02:00",
                actualArrivalTime: "2026-04-21T21:59:59+02:00",
                aimedDepartureTime: "2026-04-21T22:04:00+02:00",
                expectedDepartureTime: "2026-04-21T22:04:44+02:00",
                actualDepartureTime: null,
                occupancyStatus: "manySeatsAvailable",
                cancellation: false,
                forBoarding: true,
                forAlighting: true,
                situations: [],
              },
            ],
          },
        },
      }),
    );

    const { getVehicleJourney } = await loadModule();
    const journey = await getVehicleJourney("entur:2026-04-21|VYG:ServiceJourney:1035_442947-R");

    expect(journey).toMatchObject({
      id: "entur:2026-04-21|VYG:ServiceJourney:1035_442947-R",
      name: "R14",
      provider: "entur",
      occupancy: "low",
    });
    expect(journey?.stops).toHaveLength(2);
    expect(journey?.stops[0]).toMatchObject({
      stopId: "entur:NSR:StopPlace:288",
      platform: "3",
      departed: true,
    });
    expect(journey?.stops[1]).toMatchObject({
      stopId: "entur:NSR:StopPlace:337",
      platform: "11",
    });
  });

  it("maps NSR accessibility, equipment, and parking metadata to facilities", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:337",
          name: { value: "Oslo S" },
          accessibilityAssessment: {
            limitations: {
              accessibilityLimitation: {
                liftFreeAccess: "TRUE",
                escalatorFreeAccess: "TRUE",
                stepFreeAccess: "TRUE",
                wheelchairAccess: "TRUE",
              },
            },
          },
          placeEquipments: {
            installedEquipmentRefOrInstalledEquipment: [
              { type: "WaitingRoomEquipment" },
              { type: "TicketingEquipment" },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        mockOk([
          {
            id: "NSR:Parking:238",
            name: { value: "Oslo S" },
            parkingVehicleTypes: ["PEDAL_CYCLE"],
          },
        ]),
      );

    const { getFacilities } = await loadModule();
    const facilities = await getFacilities("entur:NSR:StopPlace:337");

    expect(facilities).toEqual([
      {
        id: "entur:NSR:StopPlace:337:accessibility:step_free",
        stopId: "entur:NSR:StopPlace:337",
        name: "Step-free access",
        type: "other",
        isAccessible: true,
        provider: "entur",
      },
      {
        id: "entur:NSR:StopPlace:337:accessibility:elevator",
        stopId: "entur:NSR:StopPlace:337",
        name: "Elevator access",
        type: "elevator",
        isAccessible: true,
        provider: "entur",
      },
      {
        id: "entur:NSR:StopPlace:337:accessibility:escalator",
        stopId: "entur:NSR:StopPlace:337",
        name: "Escalator access",
        type: "escalator",
        isAccessible: true,
        provider: "entur",
      },
      {
        id: "entur:NSR:StopPlace:337:amenity:waiting_room:Waiting room",
        stopId: "entur:NSR:StopPlace:337",
        name: "Waiting room",
        type: "other",
        isAccessible: true,
        provider: "entur",
      },
      {
        id: "entur:NSR:StopPlace:337:amenity:ticketing:Ticketing",
        stopId: "entur:NSR:StopPlace:337",
        name: "Ticketing",
        type: "other",
        isAccessible: true,
        provider: "entur",
      },
      {
        id: "NSR:Parking:238",
        stopId: "entur:NSR:StopPlace:337",
        name: "Oslo S",
        type: "bike_storage",
        isAccessible: true,
        provider: "entur",
      },
    ]);
  });

  it("builds parent stop infrastructure from NSR children, parkings, fare zones, and topographic places", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:59872",
          name: { value: "Oslo S" },
          centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
          weighting: "PREFERRED_INTERCHANGE",
          topographicPlaceRef: { ref: "KVE:TopographicPlace:0301" },
        }),
      )
      .mockResolvedValueOnce(
        mockOk([
          {
            id: "NSR:StopPlace:337",
            name: { value: "Oslo S rail" },
            centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
            transportMode: "RAIL",
            stopPlaceType: "RAIL_STATION",
            parentSiteRef: { ref: "NSR:StopPlace:59872" },
            accessibilityAssessment: {
              limitations: { accessibilityLimitation: { stepFreeAccess: "TRUE" } },
            },
            placeEquipments: {
              installedEquipmentRefOrInstalledEquipment: [{ type: "TicketingEquipment" }],
            },
            quays: {
              quayRefOrQuay: [
                {
                  id: "NSR:Quay:571",
                  publicCode: "11",
                  centroid: { location: { latitude: 59.9111, longitude: 10.755 } },
                },
              ],
            },
            tariffZones: { tariffZoneRef: [{ ref: "RUT:FareZone:4" }] },
          },
          {
            id: "NSR:StopPlace:4067",
            name: { value: "Oslo S metro" },
            centroid: { location: { latitude: 59.9115, longitude: 10.7528 } },
            transportMode: "METRO",
            stopPlaceType: "METRO_STATION",
            parentSiteRef: { ref: "NSR:StopPlace:59872" },
            placeEquipments: {
              installedEquipmentRefOrInstalledEquipment: [{ type: "WaitingRoomEquipment" }],
            },
            quays: {
              quayRefOrQuay: [
                {
                  id: "NSR:Quay:7333",
                  publicCode: "1",
                  centroid: { location: { latitude: 59.9115, longitude: 10.7529 } },
                },
              ],
            },
            tariffZones: { tariffZoneRef: [{ ref: "RUT:FareZone:4" }] },
          },
        ]),
      )
      .mockResolvedValueOnce(mockOk([]))
      .mockResolvedValueOnce(
        mockOk([
          {
            id: "NSR:Parking:238",
            name: { value: "Oslo S Bike Parking" },
            parkingVehicleTypes: ["PEDAL_CYCLE"],
            centroid: { location: { latitude: 59.9101, longitude: 10.7518 } },
          },
        ]),
      )
      .mockResolvedValueOnce(mockOk([]))
      .mockResolvedValueOnce(
        mockOk({
          id: "RUT:FareZone:4",
          name: { value: "Zone 1" },
          transportOrganisationRef: { value: { ref: "RUT:Authority:RUT" } },
          privateCode: { value: "227" },
          polygon: { type: "Polygon" },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "KVE:TopographicPlace:0301",
          descriptor: { name: { value: "Oslo" } },
          topographicPlaceType: "MUNICIPALITY",
          parentTopographicPlaceRef: { ref: "KVE:TopographicPlace:03" },
        }),
      );

    const { getStopInfrastructure } = await loadModule();
    const infrastructure = await getStopInfrastructure("entur:NSR:StopPlace:59872");

    expect(infrastructure).toMatchObject({
      stopId: "entur:NSR:StopPlace:59872",
      focusLevel: "parent_stop",
      requestedStop: {
        id: "entur:NSR:StopPlace:59872",
        name: "Oslo S",
      },
      childStops: expect.arrayContaining([
        expect.objectContaining({
          id: "entur:NSR:StopPlace:337",
          name: "Oslo S rail",
        }),
        expect.objectContaining({
          id: "entur:NSR:StopPlace:4067",
          name: "Oslo S metro",
        }),
      ]),
      platforms: expect.arrayContaining([
        expect.objectContaining({
          id: "entur:NSR:Quay:571",
          publicCode: "11",
          parentStopId: "entur:NSR:StopPlace:337",
        }),
        expect.objectContaining({
          id: "entur:NSR:Quay:7333",
          publicCode: "1",
          parentStopId: "entur:NSR:StopPlace:4067",
        }),
      ]),
      fareZones: expect.arrayContaining([
        expect.objectContaining({
          id: "RUT:FareZone:4",
          name: "Zone 1",
        }),
      ]),
      parking: expect.arrayContaining([
        expect.objectContaining({
          id: "NSR:Parking:238",
          kind: "bike_parking",
        }),
      ]),
      topographicPlace: {
        id: "KVE:TopographicPlace:0301",
        name: "Oslo",
        placeType: "MUNICIPALITY",
        parentTopographicPlaceId: "KVE:TopographicPlace:03",
      },
    });
    expect(infrastructure?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Transport modes",
          value: "Rail, Subway",
        }),
      ]),
    );
  });

  it("builds child stop infrastructure with parent and sibling context", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:337",
          name: { value: "Oslo S rail" },
          centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
          transportMode: "RAIL",
          stopPlaceType: "RAIL_STATION",
          weighting: "PREFERRED_INTERCHANGE",
          parentSiteRef: { ref: "NSR:StopPlace:59872" },
          topographicPlaceRef: { ref: "KVE:TopographicPlace:0301" },
          accessibilityAssessment: {
            limitations: { accessibilityLimitation: { stepFreeAccess: "TRUE" } },
          },
          placeEquipments: {
            installedEquipmentRefOrInstalledEquipment: [{ type: "TicketingEquipment" }],
          },
          quays: {
            quayRefOrQuay: [
              {
                id: "NSR:Quay:571",
                publicCode: "11",
                centroid: { location: { latitude: 59.9111, longitude: 10.755 } },
                boardingPositions: {
                  boardingPositionRefOrBoardingPosition: [{ publicCode: "A" }, { publicCode: "B" }],
                },
              },
            ],
          },
          tariffZones: { tariffZoneRef: [{ ref: "RUT:FareZone:4" }] },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:59872",
          name: { value: "Oslo S" },
          centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
        }),
      )
      .mockResolvedValueOnce(
        mockOk([
          {
            id: "NSR:StopPlace:337",
            name: { value: "Oslo S rail" },
            centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
            transportMode: "RAIL",
            stopPlaceType: "RAIL_STATION",
            parentSiteRef: { ref: "NSR:StopPlace:59872" },
          },
          {
            id: "NSR:StopPlace:4067",
            name: { value: "Oslo S metro" },
            centroid: { location: { latitude: 59.9115, longitude: 10.7528 } },
            transportMode: "METRO",
            stopPlaceType: "METRO_STATION",
            parentSiteRef: { ref: "NSR:StopPlace:59872" },
          },
        ]),
      )
      .mockResolvedValueOnce(mockOk([]))
      .mockResolvedValueOnce(
        mockOk({
          id: "RUT:FareZone:4",
          name: { value: "Zone 1" },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "KVE:TopographicPlace:0301",
          descriptor: { name: { value: "Oslo" } },
          topographicPlaceType: "MUNICIPALITY",
        }),
      );

    const { getStopInfrastructure } = await loadModule();
    const infrastructure = await getStopInfrastructure("entur:NSR:StopPlace:337");

    expect(infrastructure).toMatchObject({
      focusLevel: "child_stop",
      canonicalStop: {
        id: "entur:NSR:StopPlace:337",
        name: "Oslo S rail",
      },
      parentStop: {
        id: "entur:NSR:StopPlace:59872",
        name: "Oslo S",
      },
      siblingStops: [
        expect.objectContaining({
          id: "entur:NSR:StopPlace:4067",
          name: "Oslo S metro",
        }),
      ],
      platforms: [
        expect.objectContaining({
          id: "entur:NSR:Quay:571",
          publicCode: "11",
          boardingPositions: ["A", "B"],
        }),
      ],
    });
  });

  it("builds quay infrastructure in the context of the owning stop place", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:Quay:571",
          publicCode: "11",
          centroid: { location: { latitude: 59.9111, longitude: 10.755 } },
          accessibilityAssessment: {
            limitations: { accessibilityLimitation: { stepFreeAccess: "TRUE" } },
          },
          boardingPositions: {
            boardingPositionRefOrBoardingPosition: [{ publicCode: "A" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:337",
          name: { value: "Oslo S rail" },
          centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
          transportMode: "RAIL",
          stopPlaceType: "RAIL_STATION",
          parentSiteRef: { ref: "NSR:StopPlace:59872" },
          topographicPlaceRef: { ref: "KVE:TopographicPlace:0301" },
          quays: {
            quayRefOrQuay: [
              {
                id: "NSR:Quay:571",
                publicCode: "11",
                centroid: { location: { latitude: 59.9111, longitude: 10.755 } },
              },
            ],
          },
          tariffZones: { tariffZoneRef: [{ ref: "RUT:FareZone:4" }] },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:59872",
          name: { value: "Oslo S" },
          centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
        }),
      )
      .mockResolvedValueOnce(
        mockOk([
          {
            id: "NSR:StopPlace:337",
            name: { value: "Oslo S rail" },
            centroid: { location: { latitude: 59.9109, longitude: 10.7532 } },
            transportMode: "RAIL",
            stopPlaceType: "RAIL_STATION",
            parentSiteRef: { ref: "NSR:StopPlace:59872" },
            quays: {
              quayRefOrQuay: [
                {
                  id: "NSR:Quay:571",
                  publicCode: "11",
                  centroid: { location: { latitude: 59.9111, longitude: 10.755 } },
                },
              ],
            },
          },
          {
            id: "NSR:StopPlace:4067",
            name: { value: "Oslo S metro" },
            centroid: { location: { latitude: 59.9115, longitude: 10.7528 } },
            transportMode: "METRO",
            stopPlaceType: "METRO_STATION",
            parentSiteRef: { ref: "NSR:StopPlace:59872" },
            quays: {
              quayRefOrQuay: [
                {
                  id: "NSR:Quay:7333",
                  publicCode: "1",
                  centroid: { location: { latitude: 59.9115, longitude: 10.7529 } },
                },
              ],
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mockOk([]))
      .mockResolvedValueOnce(mockOk([]))
      .mockResolvedValueOnce(
        mockOk({
          id: "RUT:FareZone:4",
          name: { value: "Zone 1" },
        }),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "KVE:TopographicPlace:0301",
          descriptor: { name: { value: "Oslo" } },
          topographicPlaceType: "MUNICIPALITY",
        }),
      );

    const { getStopInfrastructure } = await loadModule();
    const infrastructure = await getStopInfrastructure("entur:NSR:Quay:571");

    expect(infrastructure).toMatchObject({
      focusLevel: "platform",
      requestedStop: {
        id: "entur:NSR:Quay:571",
        level: "platform",
      },
      canonicalStop: {
        id: "entur:NSR:StopPlace:337",
        name: "Oslo S rail",
      },
      parentStop: {
        id: "entur:NSR:StopPlace:59872",
        name: "Oslo S",
      },
      siblingStops: [
        expect.objectContaining({
          id: "entur:NSR:StopPlace:4067",
        }),
      ],
      platforms: [
        expect.objectContaining({
          id: "entur:NSR:Quay:571",
          publicCode: "11",
        }),
        expect.objectContaining({
          id: "entur:NSR:Quay:7333",
          publicCode: "1",
        }),
      ],
    });
  });

  it("falls back to deprecated tariff zones and keeps sparse parent-stop infrastructure usable", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockOk({
          id: "NSR:StopPlace:999",
          name: { value: "Legacy bus terminal" },
          centroid: { location: { latitude: 59.9, longitude: 10.7 } },
          transportMode: "BUS",
          stopPlaceType: "BUS_STATION",
          polygon: nsrPolygon(59.9, 10.7, 59.9, 10.71, 59.91, 10.71, 59.91, 10.7, 59.9, 10.7),
          tariffZones: { tariffZoneRef: [{ ref: "RUT:TariffZone:1" }] },
        }),
      )
      .mockResolvedValueOnce(mockOk([]))
      .mockResolvedValueOnce(
        mockOk([
          {
            id: "NSR:Parking:124",
            name: { value: "Legacy P+R" },
            parkingVehicleTypes: ["CAR"],
            totalCapacity: 50,
            centroid: { location: { latitude: 59.9005, longitude: 10.7005 } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockOk({
          id: "RUT:TariffZone:1",
          name: { value: "Legacy Zone" },
          privateCode: { value: "TZ1" },
          polygon: nsrPolygon(59.89, 10.69, 59.89, 10.72, 59.92, 10.72, 59.92, 10.69, 59.89, 10.69),
        }),
      );

    const { getStopInfrastructure } = await loadModule();
    const infrastructure = await getStopInfrastructure("entur:NSR:StopPlace:999");

    expect(infrastructure?.focusLevel).toBe("parent_stop");
    expect(infrastructure?.childStops).toEqual([]);
    expect(infrastructure?.platforms).toEqual([]);
    expect(infrastructure?.accessibility).toEqual([]);
    expect(infrastructure?.amenities).toEqual([]);
    expect(infrastructure?.parking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "NSR:Parking:124",
          kind: "park_and_ride",
          capacity: 50,
        }),
      ]),
    );
    expect(infrastructure?.fareZones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "RUT:TariffZone:1",
          name: "Legacy Zone",
          isDeprecatedTariffZone: true,
        }),
      ]),
    );
    expect(infrastructure?.geometry?.stopArea?.type).toBe("Polygon");
    expect(infrastructure?.geometry?.fareZones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fareZoneId: "RUT:TariffZone:1",
          geometry: expect.objectContaining({
            type: "Polygon",
          }),
        }),
      ]),
    );
    expect(infrastructure?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Transport modes",
          value: "Bus",
        }),
      ]),
    );
  });
});
