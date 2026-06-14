"use client";

import type { Route, TravelMode } from "@integrations/routing/types";
import {
  type FixInput,
  NAV_RECORDING_VERSION,
  type NavRecording,
  type RecordedReroute,
} from "@openmapx/core";
import { useCallback, useEffect, useRef } from "react";
import { useNavRecordingStore } from "./navRecordingStore";

interface Buffer {
  startedAtMs: number;
  mode: TravelMode;
  route: Route;
  lastRoute: Route;
  reroutes: RecordedReroute[];
  fixes: FixInput[];
}

function assemble(b: Buffer): NavRecording {
  return {
    version: NAV_RECORDING_VERSION,
    startedAtMs: b.startedAtMs,
    mode: b.mode,
    route: b.route,
    reroutes: b.reroutes,
    fixes: b.fixes,
  };
}

/** Prompt a download of the recording as pretty-printed JSON. */
function download(rec: NavRecording): void {
  const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nav-recording-${rec.startedAtMs}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Capture the live navigation fix stream into a downloadable {@link NavRecording}
 * while {@link useNavRecordingStore} is recording. Returns a `capture(fix, route,
 * mode)` to call from the engine's fix handler; tracks route swaps as reroute
 * boundaries. When recording stops, the buffered session is downloaded as JSON.
 */
export function useNavRecorder(): (fix: FixInput, route: Route, mode: TravelMode) => void {
  const recording = useNavRecordingStore((s) => s.recording);
  const setFixCount = useNavRecordingStore((s) => s.setFixCount);
  const bufferRef = useRef<Buffer | null>(null);

  // Reset the buffer when recording starts; download it when recording stops.
  useEffect(() => {
    if (recording) {
      bufferRef.current = null;
    } else if (bufferRef.current && bufferRef.current.fixes.length > 0) {
      download(assemble(bufferRef.current));
      bufferRef.current = null;
    }
  }, [recording]);

  // Flush any in-progress recording on unmount. Ending navigation ("End", or End
  // from the arrival card) unmounts the nav view — and this recorder — without
  // ever flipping `recording` to false, so without this the drive recorded right
  // up to the end would be silently lost.
  useEffect(
    () => () => {
      if (bufferRef.current && bufferRef.current.fixes.length > 0) {
        download(assemble(bufferRef.current));
        bufferRef.current = null;
      }
    },
    [],
  );

  return useCallback(
    (fix, route, mode) => {
      if (!useNavRecordingStore.getState().recording) return;
      let b = bufferRef.current;
      if (!b) {
        b = {
          startedAtMs: fix.timestampMs,
          mode,
          route,
          lastRoute: route,
          reroutes: [],
          fixes: [],
        };
        bufferRef.current = b;
      } else if (route !== b.lastRoute) {
        // A new route object means a reroute / stop-add applied; mark the
        // boundary at the current fix count so replay can swap routes there.
        b.reroutes.push({ afterFixCount: b.fixes.length, route });
        b.lastRoute = route;
      }
      b.fixes.push(fix);
      setFixCount(b.fixes.length);
    },
    [setFixCount],
  );
}
