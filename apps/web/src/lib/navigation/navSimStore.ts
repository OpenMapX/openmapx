import { create } from "zustand";

/**
 * Developer/QA navigation simulator state. When `enabled`, the navigation
 * engine swaps the real geolocation source for synthetic fixes that walk the
 * active route, so voice, off-route, reroute, speed-limit and camera behaviour
 * can be exercised without driving. Enabled via the `?navsim=1` URL flag (see
 * {@link useNavigationEngine}); never on by default.
 */

/** Simulated time between successive fixes (ms), matching real ~1 Hz GPS. */
export const SIM_INTERVAL_MS = 1000;

/** Ground-speed presets surfaced in the control, m/s. */
export const SIM_SPEED_PRESETS = [
  { key: "walk", mps: 1.4 },
  { key: "bike", mps: 5.5 },
  { key: "city", mps: 14 },
  { key: "highway", mps: 33 },
] as const;

/** Lateral offset (m) applied when the off-route toggle is on — trips reroute. */
const OFF_ROUTE_OFFSET_METERS = 60;

interface NavSimState {
  enabled: boolean;
  /** Target ground speed, m/s. */
  speedMps: number;
  /** Wall-clock playback multiplier (1 = real time). */
  playbackRate: number;
  /** Lateral offset, m; 0 = on-route, >0 = deliberately off-route. */
  offsetMeters: number;
  setEnabled: (v: boolean) => void;
  setSpeedMps: (v: number) => void;
  setPlaybackRate: (v: number) => void;
  toggleOffRoute: () => void;
}

export const useNavSimStore = create<NavSimState>((set) => ({
  enabled: false,
  speedMps: 14,
  playbackRate: 1,
  offsetMeters: 0,
  setEnabled: (enabled) => set({ enabled }),
  setSpeedMps: (speedMps) => set({ speedMps }),
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
  toggleOffRoute: () =>
    set((s) => ({ offsetMeters: s.offsetMeters > 0 ? 0 : OFF_ROUTE_OFFSET_METERS })),
}));
