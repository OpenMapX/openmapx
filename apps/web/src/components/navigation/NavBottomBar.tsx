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
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

interface Props {
  durationRemaining: number;
  etaEpochMs: number;
  keepScreenOn: boolean;
  onToggleKeepScreenOn: () => void;
  onEnd: () => void;
  /** Distance remaining; omit for transit, which has no single trip distance. */
  distanceRemaining?: number;
  units?: "metric" | "imperial";
  /** Voice toggle; omit to hide the voice button (transit has no voice guidance). */
  voiceEnabled?: boolean;
  onToggleVoice?: () => void;
  /** Overview action; omit to drop the "Route overview" menu item. */
  onOverview?: () => void;
  /**
   * Overrides the default secondary line ("{distance} · ETA {time}"). Transit
   * passes its own "Arrive {time}" here since it shows no distance.
   */
  secondary?: ReactNode;
}

export function NavBottomBar({
  durationRemaining,
  etaEpochMs,
  keepScreenOn,
  onToggleKeepScreenOn,
  onEnd,
  distanceRemaining,
  units = "metric",
  voiceEnabled,
  onToggleVoice,
  onOverview,
  secondary,
}: Props) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const etaTime = fmt.time(etaEpochMs);
  const secondaryLine =
    secondary ??
    (distanceRemaining != null
      ? `${formatMeasurementDistance(distanceRemaining, units)} · ${t("eta", { time: etaTime })}`
      : t("eta", { time: etaTime }));

  const closeMenu = () => setMenuAnchor(null);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5 }}>
      <IconButton
        onClick={onEnd}
        aria-label={t("end")}
        // borderRadius: the app-wide MuiIconButton override (providers.tsx) sets
        // a rounded-square radius; force a full circle so the visible border is
        // round rather than a rounded square.
        sx={{
          border: "1px solid",
          borderColor: "divider",
          color: "text.primary",
          borderRadius: "50%",
        }}
      >
        <CloseIcon />
      </IconButton>
      <Box sx={{ flexGrow: 1, textAlign: "center", minWidth: 0 }} role="status" aria-live="polite">
        <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.15 }}>
          {formatDuration(durationRemaining)}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {secondaryLine}
        </Typography>
      </Box>
      {onToggleVoice && (
        <IconButton
          onClick={onToggleVoice}
          aria-label={t(voiceEnabled ? "muteVoice" : "unmuteVoice")}
        >
          {voiceEnabled ? <VolumeUpIcon /> : <VolumeOffIcon />}
        </IconButton>
      )}
      <IconButton
        onClick={(e) => setMenuAnchor(e.currentTarget)}
        aria-label={t("moreOptions")}
        aria-haspopup="menu"
      >
        <MoreVertIcon />
      </IconButton>
      <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu}>
        {onOverview && (
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
        )}
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
