import type { StreetLevelRef } from "../types/streetLevel";
import { createOverlayStore } from "./createOverlayStore";

/**
 * The single street-level-imagery overlay store, shared by every provider. It lives in
 * core rather than in an integration so that enabling a second provider cannot
 * collide on the `street-level-imagery` overlay id.
 */
export const useStreetLevelStore = createOverlayStore({
  overlayId: "street-level-imagery",
  extra: {
    activeImage: null as StreetLevelRef | null,
    pendingImage: null as StreetLevelRef | null,
    /** Providers whose third-party data notice the user has accepted. */
    acceptedProviders: [] as string[],
  },
  actions: (set) => ({
    requestImageLoad: (ref: StreetLevelRef) =>
      set((state) =>
        state.acceptedProviders.includes(ref.providerId)
          ? { activeImage: ref, pendingImage: null }
          : { pendingImage: ref },
      ),
    confirmPendingImageLoad: () =>
      set((state) => {
        const pending = state.pendingImage;
        if (!pending) return {};
        return {
          activeImage: pending,
          pendingImage: null,
          acceptedProviders: state.acceptedProviders.includes(pending.providerId)
            ? state.acceptedProviders
            : [...state.acceptedProviders, pending.providerId],
        };
      }),
    cancelPendingImageLoad: () => set({ pendingImage: null }),
    closeViewer: () => set({ activeImage: null, pendingImage: null }),
  }),
  onClose: () => ({ activeImage: null, pendingImage: null }),
});
