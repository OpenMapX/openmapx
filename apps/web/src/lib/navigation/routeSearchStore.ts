import type { BrandSummary } from "@openmapx/core";
import { create } from "zustand";

/**
 * Shared "search along route" session state. The entry button lives in the map
 * control stack ({@link MapControls}) so it sits with the other on-map controls,
 * while the picker sheet, result pins and POI card render from
 * {@link RouteSearchControl}; both read this store. `categoryKey` is a
 * `CategoryId` or `preset:<id>` (see {@link useRouteSearch}); `brand` is a
 * specific chain picked from the picker's brand suggestions. The two are
 * mutually exclusive — picking one clears the other.
 */
interface RouteSearchState {
  /** The category picker sheet is open. */
  open: boolean;
  /** Active search category; null when not searching by category. */
  categoryKey: string | null;
  /** Active search brand; null when not searching by chain. */
  brand: BrandSummary | null;
  openPicker: () => void;
  closePicker: () => void;
  /** Pick a category: start showing its results and close the picker. */
  setCategoryKey: (key: string | null) => void;
  /** Pick a chain: start showing its results and close the picker. */
  setBrand: (brand: BrandSummary | null) => void;
  /** Exit search entirely (clear results + picker). */
  reset: () => void;
}

export const useRouteSearchStore = create<RouteSearchState>((set) => ({
  open: false,
  categoryKey: null,
  brand: null,
  openPicker: () => set({ open: true }),
  closePicker: () => set({ open: false }),
  setCategoryKey: (categoryKey) => set({ categoryKey, brand: null, open: false }),
  setBrand: (brand) => set({ brand, categoryKey: null, open: false }),
  reset: () => set({ open: false, categoryKey: null, brand: null }),
}));
