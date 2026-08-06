"use client";

import { useNavigationStore } from "@openmapx/core";
import { useNavigationSessionPersistence } from "@/lib/navigation/useNavigationSessionPersistence";
import { GroundNavigationChrome } from "./GroundNavigationChrome";
import { GroundNavigationRuntime } from "./GroundNavigationRuntime";
import { NavigationConnectivityTracker } from "./NavigationConnectivityTracker";
import { NavigationSessionResumeDialog } from "./NavigationSessionResumeDialog";

/**
 * The gate: picks which of three ground-navigation roots to show — the
 * resume prompt, nothing, or the live chrome — from `status`/`kind` alone, so
 * nothing those roots do ever re-renders this component or each other.
 * `useNavigationSessionPersistence` stays here and stays unconditional (not
 * gated on `active`) because it is what detects a pending session while idle,
 * which is what makes the resume prompt possible in the first place.
 */
export function NavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const session = useNavigationSessionPersistence();

  // Ground nav only; transit navigation is handled by TransitNavigationView.
  const active = status !== "idle" && kind === "ground";

  return (
    <>
      <NavigationConnectivityTracker />
      {session.pending && status === "idle" && kind === "ground" ? (
        <NavigationSessionResumeDialog
          snapshot={session.pending}
          coverage={session.coverage}
          onResume={session.accept}
          onDiscard={() => void session.discard()}
        />
      ) : active ? (
        <>
          <GroundNavigationRuntime />
          <GroundNavigationChrome coverage={session.coverage} />
        </>
      ) : null}
    </>
  );
}
