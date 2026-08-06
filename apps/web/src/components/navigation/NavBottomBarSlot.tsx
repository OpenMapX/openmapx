"use client";

import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import type { ReactNode } from "react";
import { useRouteSearchStore } from "@/lib/navigation/routeSearchStore";
import { NavBottomBar } from "./NavBottomBar";

interface Props {
  /** Desktop-only chevron for revealing the nav menu; the cold owner supplies it. */
  menuToggle?: ReactNode;
}

/**
 * The distance/time/ETA readout. Subscribes to `progress` and `route` itself
 * so it re-renders on every fix without dragging the cold layout (or the
 * dialogs/menu the layout also owns) along with it.
 */
export function NavBottomBarSlot({ menuToggle }: Props) {
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);
  const units = useSettingsStore((s) => s.units);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);
  const openRouteSearch = useRouteSearchStore((s) => s.openPicker);
  const routeSearchOpen = useRouteSearchStore((s) => s.open);

  const distanceRemaining = progress?.distanceRemaining ?? route?.distance ?? 0;
  const durationRemaining = progress?.durationRemaining ?? route?.duration ?? 0;
  const etaEpochMs = progress?.etaEpochMs ?? Date.now() + durationRemaining * 1000;

  return (
    <NavBottomBar
      distanceRemaining={distanceRemaining}
      durationRemaining={durationRemaining}
      etaEpochMs={etaEpochMs}
      onSearch={routeSearchOpen ? undefined : openRouteSearch}
      onEnd={stopNavigation}
      units={units}
      menuToggle={menuToggle}
    />
  );
}
