import { create } from "zustand";

/**
 * Whether the user's last attempt to end a native trip failed.
 *
 * The trip is then still running natively, with location and voice, so the
 * user has to be told rather than left looking at guidance that did not go
 * away. Every End control reports here and one notice shows it.
 */
interface NativeEndFailureState {
  failed: boolean;
  report(): void;
  dismiss(): void;
}

export const useNativeEndFailure = create<NativeEndFailureState>((set) => ({
  failed: false,
  report: () => set({ failed: true }),
  dismiss: () => set({ failed: false }),
}));
