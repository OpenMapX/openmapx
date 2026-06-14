"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { NavRecording } from "@openmapx/core";
import { useRef } from "react";
import { useNavRecordingStore } from "@/lib/navigation/navRecordingStore";
import { SIM_SPEED_PRESETS, useNavSimStore } from "@/lib/navigation/navSimStore";

const PLAYBACK_RATES = [1, 2, 4] as const;

/**
 * Floating developer control for the navigation simulator. Renders only when
 * the simulator is enabled (`?navsim=1`); lets you pick a ground speed, fast
 * forward, and toggle a deliberate off-route deviation to exercise rerouting.
 * Deliberately unstyled-for-production — this is a QA aid, not a user feature.
 */
export function NavSimControl() {
  const enabled = useNavSimStore((s) => s.enabled);
  const speedMps = useNavSimStore((s) => s.speedMps);
  const playbackRate = useNavSimStore((s) => s.playbackRate);
  const offsetMeters = useNavSimStore((s) => s.offsetMeters);
  const setSpeedMps = useNavSimStore((s) => s.setSpeedMps);
  const setPlaybackRate = useNavSimStore((s) => s.setPlaybackRate);
  const toggleOffRoute = useNavSimStore((s) => s.toggleOffRoute);

  const recording = useNavRecordingStore((s) => s.recording);
  const fixCount = useNavRecordingStore((s) => s.fixCount);
  const loaded = useNavRecordingStore((s) => s.loaded);
  const replaying = useNavRecordingStore((s) => s.replaying);
  const startRecording = useNavRecordingStore((s) => s.startRecording);
  const stopRecording = useNavRecordingStore((s) => s.stopRecording);
  const loadRecording = useNavRecordingStore((s) => s.loadRecording);
  const startReplay = useNavRecordingStore((s) => s.startReplay);
  const stopReplay = useNavRecordingStore((s) => s.stopReplay);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-loading the same file
    if (!file) return;
    try {
      const rec = JSON.parse(await file.text()) as NavRecording;
      // Validate the shape the replayer relies on (a 2+ point route geometry and
      // at least one fix); normalize a missing reroutes list. A truncated/edited
      // file is ignored rather than crashing replay — this is a dev aid.
      const valid =
        Array.isArray(rec?.fixes) &&
        rec.fixes.length > 0 &&
        Array.isArray(rec?.route?.geometry) &&
        rec.route.geometry.length >= 2;
      if (valid) {
        loadRecording({ ...rec, reroutes: Array.isArray(rec.reroutes) ? rec.reroutes : [] });
      }
    } catch {
      // Ignore malformed files — this is a dev aid.
    }
  };

  if (!enabled) return null;

  return (
    <Box
      sx={{
        pointerEvents: "auto",
        position: "fixed",
        top: "calc(var(--omx-safe-top) + 96px)",
        right: 8,
        zIndex: 1400,
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
        p: 1,
        bgcolor: "rgba(0,0,0,0.78)",
        color: "#fff",
        borderRadius: 2,
        maxWidth: 168,
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>
        NAV SIM
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {SIM_SPEED_PRESETS.map((p) => (
          <Chip
            key={p.key}
            label={p.key}
            size="small"
            color={speedMps === p.mps ? "primary" : "default"}
            onClick={() => setSpeedMps(p.mps)}
          />
        ))}
      </Box>
      <Box sx={{ display: "flex", gap: 0.5 }}>
        {PLAYBACK_RATES.map((r) => (
          <Chip
            key={r}
            label={`${r}×`}
            size="small"
            color={playbackRate === r ? "primary" : "default"}
            onClick={() => setPlaybackRate(r)}
          />
        ))}
      </Box>
      <Chip
        label={offsetMeters > 0 ? "off-route: on" : "off-route: off"}
        size="small"
        color={offsetMeters > 0 ? "warning" : "default"}
        onClick={toggleOffRoute}
      />

      <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.5, mt: 0.5 }}>
        RECORD / REPLAY
      </Typography>
      <Chip
        label={recording ? `recording… (${fixCount})` : "record"}
        size="small"
        color={recording ? "error" : "default"}
        onClick={recording ? stopRecording : startRecording}
      />
      <Box sx={{ display: "flex", gap: 0.5 }}>
        <Chip label="load…" size="small" onClick={() => fileRef.current?.click()} />
        <Chip
          label={replaying ? "stop" : "replay"}
          size="small"
          color={replaying ? "warning" : loaded ? "primary" : "default"}
          disabled={!loaded}
          onClick={replaying ? stopReplay : startReplay}
        />
      </Box>
      {loaded && (
        <Typography variant="caption" sx={{ opacity: 0.7 }}>
          loaded: {loaded.fixes.length} fixes
        </Typography>
      )}
      <input ref={fileRef} type="file" accept="application/json" hidden onChange={onFile} />
    </Box>
  );
}
