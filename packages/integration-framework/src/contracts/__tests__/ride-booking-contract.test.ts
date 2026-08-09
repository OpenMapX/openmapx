import { describe, expect, it } from "vitest";
import { assertRideProviderContract } from "../assert-contract";
import type {
  RideBooking,
  RideBookingRequest,
  RideBookingState,
  RideProvider,
} from "../ride-provider";

/**
 * An in-memory provider implementing every optional method, including the
 * booking and tracking surface no shipped provider uses. It exists so the
 * contract is proven to work end-to-end before a commercial partnership lands
 * against it, rather than being discovered to be wrong at that point.
 */
function createFakeBookingProvider(): RideProvider & { advance(id: string): void } {
  const bookings = new Map<string, RideBooking>();
  const ORDER: RideBookingState[] = ["pending", "accepted", "arriving", "in-progress", "completed"];
  let counter = 0;

  return {
    id: "fake-partner",
    meta: { name: "Fake Partner", homepage: "https://example.com/", sourceId: "fake-partner" },
    capabilities: { deepLink: true, quote: true, booking: true, tracking: true },
    permitsComparison: false,
    attribution: [{ sourceId: "fake-partner", name: "Fake Partner" }],
    quoteTtlSeconds: 30,

    async getAvailability() {
      return {
        data: {
          available: true,
          coverageChecked: true,
          products: [{ id: "std", name: "Standard", seats: 4 }],
        },
        attributions: [],
        freshness: {
          fetchedAt: "2026-08-09T00:00:00.000Z",
          hasRealtimeData: true,
          isStale: false,
        },
      };
    },

    createHandoff() {
      return { webUrl: "https://example.com/ride", carriesCoordinates: false };
    },

    async getQuotes() {
      return {
        data: [
          {
            productId: "std",
            product: { id: "std", name: "Standard" },
            pickupEtaSeconds: 300,
            fare: { amount: 12, currency: "EUR", basis: "quoted" as const },
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
        attributions: [],
        freshness: {
          fetchedAt: "2026-08-09T00:00:00.000Z",
          hasRealtimeData: true,
          isStale: false,
        },
      };
    },

    async book(request: RideBookingRequest) {
      counter += 1;
      const booking: RideBooking = {
        id: `b-${counter}`,
        providerId: "fake-partner",
        state: "pending",
        product: { id: request.productId, name: "Standard" },
        pickupEtaSeconds: 300,
        updatedAt: "2026-08-09T00:00:00.000Z",
      };
      bookings.set(booking.id, booking);
      return booking;
    },

    async getBooking(bookingId: string) {
      const booking = bookings.get(bookingId);
      if (!booking) throw new Error(`unknown booking ${bookingId}`);
      return booking;
    },

    async cancelBooking(bookingId: string) {
      const booking = bookings.get(bookingId);
      if (!booking) throw new Error(`unknown booking ${bookingId}`);
      if (booking.state === "completed") throw new Error("a completed ride cannot be cancelled");
      const cancelled = { ...booking, state: "cancelled" as const };
      bookings.set(bookingId, cancelled);
      return cancelled;
    },

    advance(id: string) {
      const booking = bookings.get(id);
      if (!booking) return;
      const next = ORDER[Math.min(ORDER.indexOf(booking.state) + 1, ORDER.length - 1)];
      bookings.set(id, {
        ...booking,
        state: next,
        driver: next === "arriving" ? { displayName: "Sam", rating: 4.9 } : booking.driver,
        vehicle: next === "arriving" ? { make: "Skoda", licensePlate: "AB-1234" } : booking.vehicle,
        driverLocation: next === "arriving" ? [13.4, 52.5] : booking.driverLocation,
      });
    },
  };
}

const request: RideBookingRequest = {
  productId: "std",
  pickup: [13.405, 52.52],
  dropoff: [13.377, 52.516],
  rider: { name: "Test Rider", phone: "+49000000000" },
};

describe("the booking surface of RideProvider", () => {
  it("satisfies the contract assertion when every capability is implemented", () => {
    expect(() => assertRideProviderContract(createFakeBookingProvider())).not.toThrow();
  });

  it("creates a booking in the pending state", async () => {
    const provider = createFakeBookingProvider();
    const booking = await provider.book?.(request);
    expect(booking?.state).toBe("pending");
    expect(booking?.providerId).toBe("fake-partner");
  });

  it("tracks a booking through to completion", async () => {
    const provider = createFakeBookingProvider();
    const booking = await provider.book?.(request);
    const id = booking?.id ?? "";
    const seen: string[] = [booking?.state ?? ""];
    for (let i = 0; i < 4; i += 1) {
      provider.advance(id);
      seen.push((await provider.getBooking?.(id))?.state ?? "");
    }
    expect(seen).toEqual(["pending", "accepted", "arriving", "in-progress", "completed"]);
  });

  it("exposes driver and vehicle details only once a vehicle is assigned", async () => {
    const provider = createFakeBookingProvider();
    const booking = await provider.book?.(request);
    const id = booking?.id ?? "";
    expect((await provider.getBooking?.(id))?.driver).toBeUndefined();
    provider.advance(id);
    provider.advance(id);
    const arriving = await provider.getBooking?.(id);
    expect(arriving?.state).toBe("arriving");
    expect(arriving?.driver?.displayName).toBe("Sam");
    expect(arriving?.vehicle?.licensePlate).toBe("AB-1234");
    expect(arriving?.driverLocation).toEqual([13.4, 52.5]);
  });

  it("cancels an in-flight booking", async () => {
    const provider = createFakeBookingProvider();
    const booking = await provider.book?.(request);
    const cancelled = await provider.cancelBooking?.(booking?.id ?? "");
    expect(cancelled?.state).toBe("cancelled");
  });

  it("refuses to cancel a completed ride", async () => {
    const provider = createFakeBookingProvider();
    const booking = await provider.book?.(request);
    const id = booking?.id ?? "";
    for (let i = 0; i < 4; i += 1) provider.advance(id);
    await expect(provider.cancelBooking?.(id)).rejects.toThrow(/completed/);
  });

  it("rejects an unknown booking id", async () => {
    const provider = createFakeBookingProvider();
    await expect(provider.getBooking?.("nope")).rejects.toThrow(/unknown booking/);
  });
});
