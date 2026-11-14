import type { LngLat } from "@openmapx/core";
import { create } from "zustand";

/** A trip stop chosen in the search. */
export interface PickedStop {
  coordinates: LngLat;
  label: string;
}

/**
 * Directions on a phone ask the main search to choose a stop: it opens full
 * screen as usual, and choosing a result fills the stop instead of opening the
 * place.
 */
export interface StopSearchRequest {
  /** The stop's current text, which the search starts from. */
  initialQuery: string;
  placeholder: string;
  onPick: (stop: PickedStop) => void;
}

interface StopSearchState {
  request: StopSearchRequest | null;
  open: (request: StopSearchRequest) => void;
  close: () => void;
}

export const useStopSearchStore = create<StopSearchState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
