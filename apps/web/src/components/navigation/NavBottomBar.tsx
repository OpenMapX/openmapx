"use client";

import CloseIcon from "@mui/icons-material/Close";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { formatDistance, formatDuration } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";

interface Props {
  distanceRemaining: number;
  durationRemaining: number;
  etaEpochMs: number;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onEnd: () => void;
  units: "metric" | "imperial";
}

export function NavBottomBar({
  distanceRemaining,
  durationRemaining,
  etaEpochMs,
  voiceEnabled,
  onToggleVoice,
  onEnd,
}: Props) {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const etaTime = new Date(etaEpochMs).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        p: 2,
        bgcolor: "background.paper",
        borderRadius: 3,
      }}
    >
      <Box sx={{ flexGrow: 1 }}>
        <Typography variant="h6">{formatDuration(durationRemaining)}</Typography>
        <Typography variant="body2" color="text.secondary">
          {formatDistance(distanceRemaining)} · {t("eta", { time: etaTime })}
        </Typography>
      </Box>
      <IconButton
        onClick={onToggleVoice}
        aria-label={t(voiceEnabled ? "muteVoice" : "unmuteVoice")}
      >
        {voiceEnabled ? <VolumeUpIcon /> : <VolumeOffIcon />}
      </IconButton>
      <Button variant="contained" color="error" startIcon={<CloseIcon />} onClick={onEnd}>
        {t("end")}
      </Button>
    </Box>
  );
}
