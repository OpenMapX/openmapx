"use client";

import { isLiveNavigationStatus, useNavigationStore } from "@openmapx/core";
import { useNavIncidentResource } from "@openmapx/integration-framework/react";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useNavCamera } from "@/lib/navigation/useNavCamera";
import { useNavigationEngine } from "@/lib/navigation/useNavigationEngine";
import { useWakeLock } from "@/lib/useWakeLock";

/**
 * Every side effect a live ground trip needs, with no visual output of its
 * own. Mounted only while ground navigation is active (`status !== "idle" &&
 * kind === "ground"`, the same predicate the gate uses to decide whether to
 * render the chrome at all), so starting/ending a trip cleanly starts/tears
 * down GPS watching, the camera loop, and the wake lock instead of running
 * them self-gated for the whole life of the map page.
 *
 * `useNavigationConnectivity` is deliberately NOT called here: it lives in
 * the always-mounted `NavigationConnectivityTracker` instead, because
 * `startGroundNavigation` reads the store's `connectivity` field synchronously
 * the moment Start is pressed — before this component would have mounted.
 *
 * Reads the nav-incident context rather than creating it: the resource is
 * owned by `NavIncidentsProvider` on the map page (a lazily-loaded
 * crowd-report prompt outside this component consumes the same context), so
 * this only subscribes to the shared resource — never a second `useNavIncidents`.
 */
export function GroundNavigationRuntime() {
  const { browserAuthority } = useMobileRuntime();

  // The camera follows whatever the store says, and under native authority the
  // store says what the shell says. Rendering is the one thing both authorities
  // share, so it stays here rather than inside the browser-only child.
  useNavCamera();

  return browserAuthority ? <BrowserGroundRuntime /> : null;
}

/**
 * The parts of a ground trip that only make sense when this page is the one
 * driving it.
 *
 * Split out as a child rather than guarded hook-by-hook so the exclusion is
 * structural: a hook added here cannot accidentally run under native authority,
 * because the component it lives in was never mounted. Inside the installed
 * shell every one of these has a native owner already — a second GPS watch, a
 * second reroute decision, or a second wake lock would each be a way for the two
 * to disagree.
 */
function BrowserGroundRuntime() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);

  const incidentResource = useNavIncidentResource();
  useNavigationEngine(incidentResource);
  // Screen stays awake through the drive itself, not the arrival card: the
  // sensors and rendering behind it are done once the trip ends.
  useWakeLock(isLiveNavigationStatus(status) && kind === "ground" && keepScreenOn);

  return null;
}
