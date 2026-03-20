import { create } from "zustand";

export type OpeningHoursFilter = "any" | "open_now" | "open_24h" | "open_at";

interface OpeningHoursState {
  openingHoursFilter: OpeningHoursFilter;
  openAtDay: number | null;
  openAtHour: number | null;
  setOpeningHoursFilter: (filter: OpeningHoursFilter) => void;
  setOpenAtFilter: (day: number | null, hour: number | null) => void;
  reset: () => void;
}

export const useOpeningHoursStore = create<OpeningHoursState>((set) => ({
  openingHoursFilter: "any",
  openAtDay: null,
  openAtHour: null,
  setOpeningHoursFilter: (openingHoursFilter) => set({ openingHoursFilter }),
  setOpenAtFilter: (openAtDay, openAtHour) =>
    set({ openingHoursFilter: "open_at", openAtDay, openAtHour }),
  reset: () => set({ openingHoursFilter: "any", openAtDay: null, openAtHour: null }),
}));
