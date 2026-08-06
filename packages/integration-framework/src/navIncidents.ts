import type { IncidentAlert, Route } from "@openmapx/core";
import { createContext, useContext } from "react";

/**
 * Ground-navigation road-condition incidents, owned by a single resource hook
 * (`useNavIncidents` in apps/web) and shared through this context with every
 * consumer — the reroute engine, the approach-alert selector, and the
 * crowd-report approach prompt — so one route drives one fetch, one 120 s
 * timer, and one route projection instead of three.
 */
export type NavIncidentStatus = "disabled" | "loading" | "fresh" | "stale" | "offline";

export interface NavIncidentResource {
  /** Incidents projected onto the active route, already filtered to what's ahead. */
  incidents: IncidentAlert[];
  /**
   * Truthful data-freshness signal. Only `"fresh"` means the current window's
   * fetch actually succeeded — a baseline-arming consumer must gate on this,
   * not merely on "a request has completed", so a transport failure can never
   * be mistaken for "fetched, no incidents".
   */
  status: NavIncidentStatus;
  /** The route this resource's data belongs to, or `null` while inactive. */
  routeIdentity: Route | null;
  /** Increments only when a fetch for the current route succeeds — never on a stale/failed one. */
  successfulRevision: number;
}

export const NavIncidentContext = createContext<NavIncidentResource | null>(null);

export function useNavIncidentResource(): NavIncidentResource {
  const ctx = useContext(NavIncidentContext);
  if (!ctx) {
    throw new Error(
      "useNavIncidentResource must be used within the OpenMapX nav-incident provider",
    );
  }
  return ctx;
}
