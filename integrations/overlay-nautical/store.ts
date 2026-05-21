import { createOverlayStore } from "@openmapx/core";

export type TideStationFilter = "all" | "tide" | "water-level" | "currents";

export interface HarborMarker {
  id: number;
  name: string;
  lng: number;
  lat: number;
  category: number;
  type: "marina" | "port" | "yacht_harbour" | "anchorage" | "fishing" | "harbour";
  wikiUrl?: string;
}

export interface HarborFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: HarborMarker;
  }>;
}

export const useNauticalStore = createOverlayStore({
  overlayId: "nautical",
  extra: {
    /** Master sub-layer toggles — independent within the nautical overlay. */
    showSeamarks: true,
    showDepth: false,
    showNoaaCharts: false,
    showHarbors: true,
    /** Show NOAA tide / water-level / currents station markers. */
    showTideStations: false,
    /** Sub-filter for which station types to display. */
    tideStationFilter: "all" as TideStationFilter,
    /** Last-fetched harbor markers for the current viewport. */
    harbors: null as HarborFeatureCollection | null,
    /** Last harbors-fetch error, if any (used to render a quiet legend hint). */
    harborsError: false,
    loading: false,
  },
  actions: (set) => ({
    setShowSeamarks: (v: boolean) => set({ showSeamarks: v }),
    setShowDepth: (v: boolean) => set({ showDepth: v }),
    setShowNoaaCharts: (v: boolean) => set({ showNoaaCharts: v }),
    setShowHarbors: (v: boolean) => set({ showHarbors: v }),
    setShowTideStations: (v: boolean) => set({ showTideStations: v }),
    setTideStationFilter: (f: TideStationFilter) => set({ tideStationFilter: f }),
    setHarbors: (h: HarborFeatureCollection | null) => set({ harbors: h }),
    setHarborsError: (e: boolean) => set({ harborsError: e }),
    setLoading: (loading: boolean) => set({ loading }),
  }),
});
