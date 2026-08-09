import { describe, expect, it } from "vitest";
import { assertRideProviderContract } from "../assert-contract";
import type { RideProvider } from "../ride-provider";

const base: RideProvider = {
  id: "fake",
  meta: { name: "Fake", homepage: "https://example.com/", sourceId: "fake" },
  capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
  permitsComparison: false,
  attribution: [{ sourceId: "fake", name: "Fake" }],
  getAvailability: async () => ({
    data: { available: true, coverageChecked: false, products: [] },
    attributions: [],
    freshness: { fetchedAt: "2026-08-09T00:00:00.000Z", hasRealtimeData: false, isStale: false },
  }),
  createHandoff: () => ({ webUrl: "https://example.com/ride", carriesCoordinates: false }),
};

describe("assertRideProviderContract", () => {
  it("accepts a deep-link-only provider", () => {
    expect(() => assertRideProviderContract(base)).not.toThrow();
  });

  it("rejects a provider claiming quote without getQuotes", () => {
    const bad = { ...base, capabilities: { ...base.capabilities, quote: true } };
    expect(() => assertRideProviderContract(bad)).toThrow(/getQuotes/);
  });

  it("rejects a provider claiming booking without book", () => {
    const bad = { ...base, capabilities: { ...base.capabilities, booking: true } };
    expect(() => assertRideProviderContract(bad)).toThrow(/book/);
  });

  it("rejects a provider claiming tracking without getBooking", () => {
    const bad = { ...base, capabilities: { ...base.capabilities, tracking: true } };
    expect(() => assertRideProviderContract(bad)).toThrow(/getBooking/);
  });

  it("rejects a provider that does not declare deepLink", () => {
    const bad = { ...base, capabilities: { ...base.capabilities, deepLink: false } };
    expect(() => assertRideProviderContract(bad)).toThrow(/deepLink/);
  });
});
