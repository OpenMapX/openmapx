import { create } from "zustand";

/** Format a Date as local `YYYY-MM-DD` (matches FlightPanel's ymd). */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Compute default [checkIn=today, checkOut=tomorrow]. Exported for tests. */
export function defaultHotelDates(now: Date): { checkIn: string; checkOut: string } {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { checkIn: ymd(now), checkOut: ymd(tomorrow) };
}

/** The `YYYY-MM-DD` one day after the given `YYYY-MM-DD` string. */
function addDayStr(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return ymd(dt);
}

interface HotelSearchState {
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  setCheckIn: (v: string) => void;
  setCheckOut: (v: string) => void;
  setAdults: (v: number) => void;
  setRooms: (v: number) => void;
  /** Initialise dates once if empty; never overwrites user edits. */
  ensureDefaults: () => void;
}

export const useHotelSearchStore = create<HotelSearchState>((set, get) => ({
  checkIn: "",
  checkOut: "",
  adults: 2,
  rooms: 1,
  // Setting check-in pushes check-out to the next day if it would otherwise be
  // on/before check-in — enforced in the store so EVERY consumer (the deep-link
  // builders, useHotelOffers) is safe, not just the date input's onChange.
  setCheckIn: (v) =>
    set((s) => ({
      checkIn: v,
      checkOut: s.checkOut && v && s.checkOut <= v ? addDayStr(v) : s.checkOut,
    })),
  // Reject a check-out on/before check-in (keep the previous valid value).
  setCheckOut: (v) => set((s) => (s.checkIn && v && v <= s.checkIn ? {} : { checkOut: v })),
  setAdults: (v) => set({ adults: Math.min(16, Math.max(1, v)) }),
  setRooms: (v) => set({ rooms: Math.min(8, Math.max(1, v)) }),
  ensureDefaults: () => {
    if (get().checkIn && get().checkOut) return;
    const { checkIn, checkOut } = defaultHotelDates(new Date());
    set({ checkIn, checkOut });
  },
}));
