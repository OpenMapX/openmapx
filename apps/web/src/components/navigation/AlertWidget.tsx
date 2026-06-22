"use client";

import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";
import TrainIcon from "@mui/icons-material/Train";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ActiveAlert, IncidentAlert, RoadAlertType } from "@openmapx/core";
import {
  formatIncidentAnnouncement,
  formatMeasurementDistance,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { haptics } from "@/lib/haptics";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";

const ICON: Record<RoadAlertType, typeof WarningAmberIcon> = {
  traffic_incident: WarningAmberIcon,
  speed_camera: PhotoCameraIcon,
  railway_crossing: TrainIcon,
  stop: WarningAmberIcon,
  pedestrian_crossing: WarningAmberIcon,
  traffic_calming: WarningAmberIcon,
  tunnel: WarningAmberIcon,
};

const LABEL_KEY: Record<RoadAlertType, string> = {
  traffic_incident: "alertTrafficIncident",
  speed_camera: "alertSpeedCamera",
  railway_crossing: "alertRailwayCrossing",
  stop: "alertStop",
  pedestrian_crossing: "alertPedestrianCrossing",
  traffic_calming: "alertTrafficCalming",
  tunnel: "alertTunnel",
};

/**
 * Compact approach-alert chip (speed camera, level crossing, …). Announces each
 * distinct alert once — a haptic pulse and, when voice guidance is on, a spoken
 * cue — then stays on screen with a live distance while the alert is ahead.
 */
export function AlertWidget({ alert }: { alert: ActiveAlert }) {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const units = useSettingsStore((s) => s.units);
  const announcedRef = useRef<string | null>(null);

  const type = alert.alert.type;
  const Icon = ICON[type];
  const incident = type === "traffic_incident" ? (alert.alert as IncidentAlert) : null;
  const label = incident ? t(`incidentType.${incident.eventType}`) : t(LABEL_KEY[type]);
  const distanceText = formatMeasurementDistance(alert.distanceMeters, units);
  const announceText = incident ? formatIncidentAnnouncement(incident, distanceText, t) : label;

  useEffect(() => {
    if (announcedRef.current === alert.alert.id) return;
    announcedRef.current = alert.alert.id;
    haptics.warn();
    if (voiceEnabled) speak(announceText);
  }, [alert.alert.id, announceText, speak, voiceEnabled]);

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        alignSelf: "flex-start",
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1.5,
        py: 0.75,
        bgcolor: alert.warn ? "error.main" : "background.paper",
        color: alert.warn ? "error.contrastText" : "text.primary",
        borderRadius: 2,
        boxShadow: 2,
      }}
    >
      <Icon sx={{ fontSize: 24 }} />
      <Box sx={{ lineHeight: 1.1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.85 }}>
          {distanceText}
        </Typography>
      </Box>
    </Box>
  );
}
