"use client";

import type { AttributionDetail } from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { AttributionLogo } from "@openmapx/mobility-core/licensing";
import { createContext, useContext, useEffect, useId } from "react";

export interface AttributionGroupContribution {
  attributions: readonly Attribution[];
  entries: readonly AttributionDetail[];
  logos: readonly AttributionLogo[];
}
type Register = (id: string, contribution: AttributionGroupContribution | null) => void;
export type AttributionGroupPlacement = "details" | "footer";
export const AttributionGroupContext = createContext<{
  register: Register;
  placement: AttributionGroupPlacement;
} | null>(null);

export function useAttributionGroupPlacement() {
  return useContext(AttributionGroupContext)?.placement;
}

/** Registers mounted content and returns how the owning panel presents its credit. */
export function useGroupedAttributionDetails(
  contribution: AttributionGroupContribution,
  enabled: boolean,
): AttributionGroupPlacement | null {
  const group = useContext(AttributionGroupContext);
  const register = group?.register;
  const id = useId();
  // Callers commonly create fresh arrays during render. Register only when the
  // captured content changes, not when this group renders its collected action.
  const snapshot = register && enabled ? JSON.stringify(contribution) : "";
  useEffect(() => {
    if (!register || !enabled) return;
    const current = JSON.parse(snapshot) as AttributionGroupContribution;
    if (current.entries.length === 0) return;
    register(id, current);
    return () => register(id, null);
  }, [register, id, snapshot, enabled]);
  return register && enabled ? group.placement : null;
}
