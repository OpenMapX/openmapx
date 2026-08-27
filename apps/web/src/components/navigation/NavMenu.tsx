"use client";

import ApartmentIcon from "@mui/icons-material/Apartment";
import ListAltIcon from "@mui/icons-material/ListAlt";
import MapIcon from "@mui/icons-material/Map";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import ScreenLockPortraitIcon from "@mui/icons-material/ScreenLockPortrait";
import SettingsIcon from "@mui/icons-material/Settings";
import TrafficOutlinedIcon from "@mui/icons-material/TrafficOutlined";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import { OVERLAY_REGISTRY, useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useSatelliteToggle } from "@/lib/navigation/satelliteToggle";
import { ActionRow, OverlayToggleRow, ToggleRow } from "./navMenuRows";

export interface NavMenuProps {
  onOpenDirections: () => void;
  onOverview: () => void;
  onOpenSettings: () => void;
}

/**
 * The navigation menu: actions (directions, overview), map-overlay toggles
 * (traffic, satellite, raised buildings), keep-screen-on, and settings.
 * Presentational — the container (sheet on mobile, panel on desktop) owns
 * layout; this owns the rows and their store wiring. Reporting stays the amber
 * FAB in the map controls (the crowd-reports integration is kept out of this
 * program), so it isn't duplicated here.
 */
export function NavMenu({ onOpenDirections, onOverview, onOpenSettings }: NavMenuProps) {
  const t = useTranslations("navigation");
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const { toggleKeepScreenOn } = useNavigationMutations();
  const satellite = useSatelliteToggle();
  const overlayIds = OVERLAY_REGISTRY.map((entry) => entry.id);

  return (
    <List disablePadding>
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
        onToggle={() => void toggleKeepScreenOn()}
      />

      <Divider component="li" />

      <ActionRow icon={<SettingsIcon />} label={t("menu.settings")} onClick={onOpenSettings} />
    </List>
  );
}
