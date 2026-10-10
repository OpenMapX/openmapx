import { createOverlayStore } from "@openmapx/core";
import type { AmbientManifest } from "@openmapx/core/ambient-places";

export const useAmbientPlacesStore = createOverlayStore({
  overlayId: "ambient-places",
  extra: {
    panelOpen: true,
    layerVisible: true,
    manifest: null as AmbientManifest | null,
    error: false,
    loading: false,
  },
  actions: (set) => ({
    setPublication: (manifest: AmbientManifest | null, error: boolean, loading: boolean) =>
      set({ manifest, error, loading }),
  }),
});
// A lazy-load placeholder with no user interaction must not override the normal-
// browsing default; a user's early toggle/deep link always wins.
if (useAmbientPlacesStore.getState().userRevision === 0)
  useAmbientPlacesStore.setState({ panelOpen: true, layerVisible: true });
