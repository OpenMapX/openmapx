import { createClient } from "@hey-api/client-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { planMock } = vi.hoisted(() => ({ planMock: vi.fn() }));
vi.mock("@motis-project/motis-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@motis-project/motis-client")>()),
  plan: planMock,
}));

import { planTrip } from "../adapter.js";

const instance = {
  client: createClient({ baseUrl: "http://motis.test" }),
  prefix: "ms:",
  provider: "ms",
};

function response() {
  return {
    data: {
      from: { name: "A", lat: 1, lon: 2 },
      to: { name: "B", lat: 3, lon: 4 },
      direct: [],
      itineraries: [],
      previousPageCursor: "previous-cursor",
      nextPageCursor: "next-cursor",
    },
  };
}

describe("MOTIS planner request mapping", () => {
  beforeEach(() => {
    planMock.mockReset().mockResolvedValue(response());
  });

  it("maps bounded controls and scoped rental filters without weakening return constraints", async () => {
    await planTrip(instance, 1, 2, 3, 4, "2026-07-15", "10:00:00", false, 3, {
      modes: ["BUS"],
      wheelchair: true,
      preTransitModes: ["RENTAL"],
      postTransitModes: ["RENTAL"],
      directModes: ["RENTAL"],
      maxTransfers: 2,
      transferBuffer: "relaxed",
      requireBikeTransport: true,
      bikeHillPreference: "strongly-avoid",
      pageCursor: "opaque-cursor",
      detailedLegs: true,
      detailedTransfers: true,
      useRoutedTransfers: true,
      rentalFilters: {
        direct: {
          formFactors: ["BICYCLE", "CARGO_BICYCLE"],
          providerIds: ["direct-provider"],
          groupIds: ["direct-group"],
          source: "local",
          instance: "ms",
          datasetEpoch: "epoch",
        },
        preTransit: {
          formFactors: ["SCOOTER_STANDING"],
          propulsionTypes: ["ELECTRIC"],
          providerIds: ["pre-provider"],
          groupIds: ["pre-group"],
          source: "local",
          instance: "ms",
          datasetEpoch: "epoch",
        },
        postTransit: {
          formFactors: ["CAR"],
          providerIds: ["post-provider"],
          groupIds: ["post-group"],
          source: "local",
          instance: "ms",
          datasetEpoch: "epoch",
        },
      },
    });

    const query = planMock.mock.calls[0][0].query;
    expect(query).toMatchObject({
      maxTransfers: 2,
      minTransferTime: 3,
      additionalTransferTime: 2,
      pedestrianProfile: "WHEELCHAIR",
      requireBikeTransport: true,
      elevationCosts: "HIGH",
      pageCursor: "opaque-cursor",
      detailedLegs: true,
      detailedTransfers: true,
      useRoutedTransfers: true,
      directRentalFormFactors: ["BICYCLE", "CARGO_BICYCLE"],
      directRentalProviders: ["direct-provider"],
      directRentalProviderGroups: ["direct-group"],
      preTransitRentalFormFactors: ["SCOOTER_STANDING"],
      preTransitRentalPropulsionTypes: ["ELECTRIC"],
      preTransitRentalProviders: ["pre-provider"],
      preTransitRentalProviderGroups: ["pre-group"],
      postTransitRentalFormFactors: ["CAR"],
      postTransitRentalProviders: ["post-provider"],
      postTransitRentalProviderGroups: ["post-group"],
    });
    expect(query).not.toHaveProperty("ignoreDirectRentalReturnConstraints");
    expect(query).not.toHaveProperty("ignorePreTransitRentalReturnConstraints");
    expect(query).not.toHaveProperty("ignorePostTransitRentalReturnConstraints");
  });

  it.each([
    ["standard", undefined, undefined],
    ["relaxed", 3, 2],
    ["extra", 5, 5],
  ] as const)("maps the %s transfer preset", async (preset, min, additional) => {
    await planTrip(instance, 1, 2, 3, 4, "2026-07-15", "10:00:00", false, 3, {
      transferBuffer: preset,
    });
    const query = planMock.mock.calls[0][0].query;
    expect(query.minTransferTime).toBe(min);
    expect(query.additionalTransferTime).toBe(additional);
  });

  it("preserves MOTIS identifiers, paging, levels, steps, flags, elevation, and rental returns", async () => {
    planMock.mockResolvedValue({
      data: {
        ...response().data,
        itineraries: [
          {
            id: "itinerary-1",
            duration: 600,
            startTime: "2026-07-15T10:00:00Z",
            endTime: "2026-07-15T10:10:00Z",
            transfers: 0,
            legs: [
              {
                mode: "RENTAL",
                from: { name: "Lower", lat: 1, lon: 2, level: -1, stopId: "from" },
                to: { name: "Upper", lat: 3, lon: 4, level: 1, stopId: "to" },
                duration: 600,
                startTime: "2026-07-15T10:00:00Z",
                endTime: "2026-07-15T10:10:00Z",
                scheduledStartTime: "2026-07-15T10:00:00Z",
                scheduledEndTime: "2026-07-15T10:10:00Z",
                realTime: true,
                scheduled: true,
                distance: 1200,
                cancelled: false,
                bikesAllowed: true,
                wheelchairAccessible: "ACCESSIBLE",
                legGeometry: { points: "", precision: 6, length: 0 },
                steps: [
                  {
                    relativeDirection: "ELEVATOR",
                    distance: 10,
                    fromLevel: -1,
                    toLevel: 1,
                    polyline: { points: "", precision: 6, length: 0 },
                    streetName: "",
                    exit: "",
                    stayOn: false,
                    area: false,
                    elevationUp: 8,
                    elevationDown: 1,
                  },
                ],
                rental: {
                  providerId: "provider",
                  providerGroupId: "group",
                  systemId: "system",
                  formFactor: "BICYCLE",
                  propulsionType: "ELECTRIC_ASSIST",
                  returnConstraint: "ROUNDTRIP_STATION",
                },
              },
            ],
          },
        ],
      },
    });

    const mapped = await planTrip(instance, 1, 2, 3, 4, "2026-07-15", "10:00:00", false, 3, {
      directModes: ["RENTAL"],
      datasetEpoch: "epoch-42",
    });
    expect(mapped).toMatchObject({
      provider: "ms",
      source: "transit-motis-local",
      instance: "ms",
      datasetEpoch: "epoch-42",
      previousPageCursor: "previous-cursor",
      nextPageCursor: "next-cursor",
      itineraries: [
        {
          id: "itinerary-1",
          datasetEpoch: "epoch-42",
          ascentMeters: 8,
          descentMeters: 1,
          legs: [
            {
              realtime: true,
              wheelchairAccessible: true,
              from: { level: -1 },
              to: { level: 1 },
              steps: [{ instruction: "ELEVATOR", elevator: true, ascentMeters: 8 }],
              rental: {
                providerId: "provider",
                providerGroupId: "group",
                formFactor: "BICYCLE",
                propulsionType: "ELECTRIC_ASSIST",
                returnConstraint: "ROUNDTRIP_STATION",
              },
            },
          ],
        },
      ],
    });
  });
});
