import { create } from "zustand";

interface RideState {
  /** Provider whose detail is currently shown. Null until providers load. */
  providerId: string | null;
  /** Product within that provider, when it offers several. */
  productId: string | null;
  passengers: number;
  /** Wall-clock pickup time `YYYY-MM-DDTHH:mm` for a pre-booked ride. */
  pickupAt: string | null;
  setProvider: (providerId: string | null) => void;
  setProduct: (productId: string | null) => void;
  setPassengers: (passengers: number) => void;
  setPickupAt: (pickupAt: string | null) => void;
  reset: () => void;
}

const INITIAL = {
  providerId: null,
  productId: null,
  passengers: 1,
  pickupAt: null,
} as const;

/**
 * Shared state for the ride directions mode. Mirrors how the flights feature
 * shares panel state through `useFlightStore` rather than threading props.
 * Selecting a provider clears the product, because product ids are
 * provider-scoped and would otherwise leak across a switch.
 */
export const useRideStore = create<RideState>((set) => ({
  ...INITIAL,
  setProvider: (providerId) => set({ providerId, productId: null }),
  setProduct: (productId) => set({ productId }),
  setPassengers: (passengers) => set({ passengers: Math.min(8, Math.max(1, passengers)) }),
  setPickupAt: (pickupAt) => set({ pickupAt }),
  reset: () => set({ ...INITIAL }),
}));
