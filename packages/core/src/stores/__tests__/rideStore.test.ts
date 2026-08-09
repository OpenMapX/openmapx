import { beforeEach, describe, expect, it } from "vitest";
import { useRideStore } from "../rideStore";

describe("useRideStore", () => {
  beforeEach(() => useRideStore.getState().reset());

  it("clears the product when the provider changes", () => {
    const s = useRideStore.getState();
    s.setProvider("uber");
    s.setProduct("uberx");
    expect(useRideStore.getState().productId).toBe("uberx");
    useRideStore.getState().setProvider("lyft");
    expect(useRideStore.getState().productId).toBeNull();
  });

  it("clamps passengers to 1..8", () => {
    useRideStore.getState().setPassengers(0);
    expect(useRideStore.getState().passengers).toBe(1);
    useRideStore.getState().setPassengers(99);
    expect(useRideStore.getState().passengers).toBe(8);
  });
});
