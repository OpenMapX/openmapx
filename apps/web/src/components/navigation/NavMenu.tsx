"use client";

import ApartmentIcon from "@mui/icons-material/Apartment";
import ListAltIcon from "@mui/icons-material/ListAlt";
import MapIcon from "@mui/icons-material/Map";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import ScreenLockPortraitIcon from "@mui/icons-material/ScreenLockPortrait";
import SettingsIcon from "@mui/icons-material/Settings";
import TrafficOutlinedIcon from "@mui/icons-material/TrafficOutlined";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Switch from "@mui/material/Switch";
import { getRegisteredOverlayIds, useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  useOverlayLayerVisible,
  useOverlaySetLayerVisible,
} from "@/components/map/overlay/useOverlayStoreState";
import { useSatelliteToggle } from "@/lib/navigation/satelliteToggle";

/** An action row: leading icon, label, tap runs `onClick`. */
function ActionRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ListItemButton onClick={onClick}>
      <ListItemIcon sx={{ minWidth: 44 }}>{icon}</ListItemIcon>
      <ListItemText primary={label} />
    </ListItemButton>
  );
}

/** A toggle row: leading icon, label, trailing Switch reflecting `checked`. */
function ToggleRow({
  icon,
  label,
  checked,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <ListItemButton onClick={() => onToggle(!checked)}>
      <ListItemIcon sx={{ minWidth: 44 }}>{icon}</ListItemIcon>
      <ListItemText primary={label} />
      <Switch edge="end" checked={checked} tabIndex={-1} disableRipple />
    </ListItemButton>
  );
}

/**
 * An overlay toggle bound to a registered overlay store by id. Rendered only
 * when the overlay is available (see {@link NavMenu}), so its hooks — which
 * resolve/create the store — always run.
 */
function OverlayToggleRow({
  overlayId,
  icon,
  label,
}: {
  overlayId: string;
  icon: ReactNode;
  label: string;
}) {
  const visible = useOverlayLayerVisible(overlayId);
  const setVisible = useOverlaySetLayerVisible(overlayId);
  return <ToggleRow icon={icon} label={label} checked={visible} onToggle={setVisible} />;
}

export interface NavMenuProps {
  crowdReportsEnabled: boolean;
  onAddReport: () => void;
  onOpenDirections: () => void;
  onOverview: () => void;
  onOpenSettings: () => void;
}

/**
 * The navigation menu: actions (report, directions, overview), map-overlay
 * toggles (traffic, satellite, raised buildings), keep-screen-on, and settings.
 * Presentational — the container (sheet on mobile, panel on desktop) owns
 * layout; this owns the rows and their store wiring.
 */
export function NavMenu({
  crowdReportsEnabled,
  onAddReport,
  onOpenDirections,
  onOverview,
  onOpenSettings,
}: NavMenuProps) {
  const t = useTranslations("navigation");
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const toggleKeepScreenOn = useNavigationStore((s) => s.toggleKeepScreenOn);
  const satellite = useSatelliteToggle();
  const overlayIds = getRegisteredOverlayIds();

  return (
    <List disablePadding>
      {crowdReportsEnabled && (
        <ActionRow
          icon={<ReportProblemOutlinedIcon sx={{ color: "#f9a825" }} />}
          label={t("menu.addReport")}
          onClick={onAddReport}
        />
      )}
      <ActionRow icon={<ListAltIcon />} label={t("menu.directions")} onClick={onOpenDirections} />
      <ActionRow icon={<MapIcon />} label={t("overview")} onClick={onOverview} />

      <Divider component="li" />

      {overlayIds.includes("traffic") && (
        <OverlayToggleRow
          overlayId="traffic"
          icon={<TrafficOutlinedIcon />}
          label={t("menu.showTraffic")}
        />
      )}
      <ToggleRow
        icon={<SatelliteAltIcon />}
        label={t("menu.showSatellite")}
        checked={satellite.on}
        onToggle={satellite.toggle}
      />
      {overlayIds.includes("3d-buildings") && (
        <OverlayToggleRow
          overlayId="3d-buildings"
          icon={<ApartmentIcon />}
          label={t("menu.showRaisedBuildings")}
        />
      )}
      <ToggleRow
        icon={<ScreenLockPortraitIcon />}
        label={t("keepScreenOn")}
        checked={keepScreenOn}
        onToggle={toggleKeepScreenOn}
      />

      <Divider component="li" />

      <ActionRow icon={<SettingsIcon />} label={t("menu.settings")} onClick={onOpenSettings} />
    </List>
  );
}
