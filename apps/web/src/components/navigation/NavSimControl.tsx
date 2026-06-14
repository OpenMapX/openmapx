"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
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
    </Box>
  );
}
