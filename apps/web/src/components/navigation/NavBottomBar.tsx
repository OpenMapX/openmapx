"use client";

import CloseIcon from "@mui/icons-material/Close";
import MapIcon from "@mui/icons-material/Map";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ScreenLockPortraitIcon from "@mui/icons-material/ScreenLockPortrait";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { formatDuration, formatMeasurementDistance } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  distanceRemaining: number;
  durationRemaining: number;
  etaEpochMs: number;
  voiceEnabled: boolean;
  keepScreenOn: boolean;
  onToggleVoice: () => void;
  onToggleKeepScreenOn: () => void;
  onOverview: () => void;
  onEnd: () => void;
  units: "metric" | "imperial";
}

export function NavBottomBar({
  distanceRemaining,
  durationRemaining,
  etaEpochMs,
  voiceEnabled,
  keepScreenOn,
  onToggleVoice,
  onToggleKeepScreenOn,
  onOverview,
  onEnd,
  units,
}: Props) {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const etaTime = new Date(etaEpochMs).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const closeMenu = () => setMenuAnchor(null);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5 }}>
      <IconButton
        onClick={onEnd}
        aria-label={t("end")}
        sx={{ border: "1px solid", borderColor: "divider", color: "text.primary" }}
      >
        <CloseIcon />
      </IconButton>
      <Box sx={{ flexGrow: 1, textAlign: "center", minWidth: 0 }} role="status" aria-live="polite">
        <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.15 }}>
          {formatDuration(durationRemaining)}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatMeasurementDistance(distanceRemaining, units)} · {t("eta", { time: etaTime })}
        </Typography>
      </Box>
      <IconButton
        onClick={onToggleVoice}
        aria-label={t(voiceEnabled ? "muteVoice" : "unmuteVoice")}
      >
        {voiceEnabled ? <VolumeUpIcon /> : <VolumeOffIcon />}
      </IconButton>
      <IconButton
        onClick={(e) => setMenuAnchor(e.currentTarget)}
        aria-label={t("moreOptions")}
        aria-haspopup="menu"
      >
        <MoreVertIcon />
      </IconButton>
      <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu}>
        <MenuItem
          onClick={() => {
            onOverview();
            closeMenu();
          }}
        >
          <ListItemIcon>
            <MapIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("overview")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => onToggleKeepScreenOn()}>
          <ListItemIcon>
            <ScreenLockPortraitIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("keepScreenOn")}</ListItemText>
          <Checkbox edge="end" checked={keepScreenOn} tabIndex={-1} disableRipple />
        </MenuItem>
      </Menu>
    </Box>
  );
}
