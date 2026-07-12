import type { LngLat } from "@openmapx/core";
import { create } from "zustand";

/**
 * UI state for the crowd-report flow: whether the report dialog is open, the
 * chosen location (`[lon, lat]`), and whether the user is currently picking a
 * location on the map. Kept out of the map instance (a plain store) so the FAB,
 * the dialog, and the `MapClickHandler` pick seam all read one source of truth.
 */
interface CrowdReportState {
  open: boolean;
  location: LngLat | null;
  /** True while the user taps the map to place the report. */
  picking: boolean;
  openDialog: (location?: LngLat | null) => void;
  closeDialog: () => void;
  setLocation: (location: LngLat) => void;
  startPicking: () => void;
  stopPicking: () => void;
}

export const useCrowdReportStore = create<CrowdReportState>((set) => ({
  open: false,
  location: null,
  picking: false,
  openDialog: (location = null) => set({ open: true, location, picking: false }),
  closeDialog: () => set({ open: false, picking: false }),
  setLocation: (location) => set({ location, picking: false, open: true }),
  startPicking: () => set({ picking: true, open: false }),
  stopPicking: () => set({ picking: false }),
}));
