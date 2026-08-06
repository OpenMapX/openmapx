"use client";

import { NavIncidentContext } from "@openmapx/integration-framework/react";
import { useNavIncidents } from "@/lib/navigation/useNavIncidents";

/**
 * The single mount point for ground-navigation road-condition data. Wraps the
 * subtree containing every consumer — the reroute engine and approach-alert
 * selector inside `<NavigationView />`, and the crowd-report approach prompt
 * lazily loaded beneath `<MapControls />` — so one route drives one fetch, one
 * 120 s timer, and one route projection, shared through
 * `@openmapx/integration-framework/react`'s nav-incident context instead of
 * each consumer calling `useNavIncidents` (and re-fetching/re-projecting)
 * independently. Stays mounted regardless of navigation state; the resource
 * itself goes idle when there's no live ground-navigation route.
 */
export function NavIncidentsProvider({ children }: { children: React.ReactNode }) {
  const resource = useNavIncidents();
  return <NavIncidentContext.Provider value={resource}>{children}</NavIncidentContext.Provider>;
}
