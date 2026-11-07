import { describe, expect, it } from "vitest";
import { assertRideProviderContract } from "../assert-contract";
import type { RideBooking, RideProvider } from "../ride-provider";

const booking: RideBooking = {
  id: "fixture-booking",
  providerId: "fake-partner",
  state: "pending",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

const provider: RideProvider = {
  id: "fake-partner",
  meta: { name: "Fake Partner", homepage: "https://example.com/", sourceId: "fake-partner" },
  capabilities: { deepLink: true, quote: true, booking: true, tracking: true },
  permitsComparison: false,
  attribution: [],
  getAvailability: async () => ({
    data: { available: true, coverageChecked: true, products: [] },
    attributions: [],
    freshness: { fetchedAt: "2026-08-09T00:00:00.000Z", hasRealtimeData: true, isStale: false },
  }),
  createHandoff: () => ({ webUrl: "https://example.com/ride", carriesCoordinates: false }),
  getQuotes: async () => ({
    data: [],
    attributions: [],
    freshness: { fetchedAt: "2026-08-09T00:00:00.000Z", hasRealtimeData: true, isStale: false },
  }),
  book: async () => booking,
  getBooking: async () => booking,
  cancelBooking: async () => booking,
};

describe("the booking surface of RideProvider", () => {
  it("satisfies the contract assertion when every capability is implemented", () => {
    expect(() => assertRideProviderContract(provider)).not.toThrow();
  });
});
