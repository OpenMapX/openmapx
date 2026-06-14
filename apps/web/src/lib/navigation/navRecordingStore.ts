import type { NavRecording } from "@openmapx/core";
import { create } from "zustand";

/**
 * Developer/QA state for recording a live navigation session and replaying it.
 * The recorder captures the raw GPS fix stream (plus the route and any reroutes)
 * so a real drive can be downloaded as JSON, replayed in-app, or re-fed through
 * the pure engine in a test (`replayRecording`). Surfaced alongside the
 * simulator (`?navsim=1`); never on by default.
 */
interface NavRecordingState {
  /** Capturing the live fix stream into a buffer. */
  recording: boolean;
  /** Fixes captured so far (for the control's live counter). */
  fixCount: number;
  /** A recording loaded from disk, available to replay. */
  loaded: NavRecording | null;
  /** Replaying `loaded` through the live engine. */
  replaying: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  setFixCount: (n: number) => void;
  loadRecording: (rec: NavRecording) => void;
  startReplay: () => void;
  stopReplay: () => void;
}

export const useNavRecordingStore = create<NavRecordingState>((set) => ({
  recording: false,
  fixCount: 0,
  loaded: null,
  replaying: false,
  startRecording: () => set({ recording: true, fixCount: 0 }),
  stopRecording: () => set({ recording: false }),
  setFixCount: (fixCount) => set({ fixCount }),
  loadRecording: (loaded) => set({ loaded, replaying: false }),
  startReplay: () => set({ replaying: true }),
  stopReplay: () => set({ replaying: false }),
}));
