import { create } from "zustand";

/**
 * How the user's last attempt to end a native trip failed, if it did.
 *
 * `refused`: native answered that it did not end the trip, so it is still
 * running with location and voice. `unconfirmed`: native did not answer in
 * time, so it may or may not have ended. Every End control reports here, and
 * each failure gets its own `id`, so a second failure while the first notice
 * is still showing is shown again rather than lost.
 */
export type NativeEndFailureKind = "refused" | "unconfirmed";

interface NativeEndFailureState {
  failure: { id: number; kind: NativeEndFailureKind } | null;
  report(kind: NativeEndFailureKind): void;
  dismiss(): void;
}

export const useNativeEndFailure = create<NativeEndFailureState>((set) => ({
  failure: null,
  report: (kind) => set((state) => ({ failure: { id: (state.failure?.id ?? 0) + 1, kind } })),
  dismiss: () => set({ failure: null }),
}));
