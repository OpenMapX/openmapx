"use client";

import { useNavIncidentResource } from "@openmapx/integration-framework/react";
import { useNavAlerts } from "@/lib/navigation/useNavAlerts";
import { AlertWidget } from "./AlertWidget";

/**
 * The approach-alert (speed camera / crossing / incident) banner. Subscribes
 * to `progress` (through `useNavAlerts`) itself, so a fix that doesn't change
 * the active alert doesn't re-render the rest of the chrome. Reads the shared
 * nav-incident context — the same resource `GroundNavigationRuntime` and the
 * map page's crowd-report prompt read — rather than creating its own.
 */
export function NavAlertSlot() {
  const activeAlert = useNavAlerts(useNavIncidentResource());
  return activeAlert ? <AlertWidget alert={activeAlert} /> : null;
}
