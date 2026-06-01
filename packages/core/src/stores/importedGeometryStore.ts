import { create } from "zustand";

export interface ImportedGeometry {
  /** Source file name, shown in the dismiss banner. */
  name: string;
  geojson: GeoJSON.FeatureCollection;
}

interface ImportedGeometryState {
  imported: ImportedGeometry | null;
  setImported: (imported: ImportedGeometry | null) => void;
  clearImported: () => void;
}

/**
 * Holds a user-imported GPX/GeoJSON/KML overlay (a route/track/places file
 * opened from the OS or the in-app importer). The map draws whatever is here;
 * clearing it removes the overlay.
 */
export const useImportedGeometryStore = create<ImportedGeometryState>((set) => ({
  imported: null,
  setImported: (imported) => set({ imported }),
  clearImported: () => set({ imported: null }),
}));
