"use client";

import MapIcon from "@mui/icons-material/Map";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import ScreenLockPortraitIcon from "@mui/icons-material/ScreenLockPortrait";
import SettingsIcon from "@mui/icons-material/Settings";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import { useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useSatelliteToggle } from "@/lib/navigation/satelliteToggle";
import { ActionRow, ToggleRow } from "./navMenuRows";

/**
 * The transit navigation menu, shown at the foot of the journey sheet (mobile)
 * or revealed by the desktop chevron. Mirrors the driving {@link NavMenu} with
 * the actions that make sense for transit: frame the whole trip, satellite view,
 * keep-screen-on, and navigation settings. The trip's step list is the journey
 * timeline above, so there's no separate "directions" row.
 */
export function TransitNavMenu({
  onOverview,
  onOpenSettings,
}: {
  onOverview: () => void;
  onOpenSettings: () => void;
}) {
  const t = useTranslations("navigation");
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const toggleKeepScreenOn = useNavigationStore((s) => s.toggleKeepScreenOn);
  const satellite = useSatelliteToggle();

  return (
    <List disablePadding>
      <Divider component="li" />
      <ActionRow icon={<MapIcon />} label={t("overview")} onClick={onOverview} />
      <ToggleRow
        icon={<SatelliteAltIcon />}
        label={t("menu.showSatellite")}
        checked={satellite.on}
        onToggle={satellite.toggle}
      />
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
