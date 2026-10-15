"use client";

import Box from "@mui/material/Box";
import { type AttributionDetail, mergeAttributionDetails } from "@openmapx/core/attribution";
import type { AttributionLogo } from "@openmapx/mobility-core/licensing";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import { AttributionDetails } from "./AttributionDetails";

interface Contribution {
  entries: readonly AttributionDetail[];
  logos: readonly AttributionLogo[];
}
type Register = (id: string, contribution: Contribution | null) => void;
const GroupContext = createContext<Register | null>(null);

/**
 * Shares content details within one displayed panel. Required adjacent notices
 * and image-specific actions stay with their content; only the detail action moves.
 * Mounted sections own their receipts, so replacements/unmounts cannot leave stale credits.
 */
export function AttributionDetailsGroup({ children }: { children: ReactNode }) {
  const [contributions, setContributions] = useState(new Map<string, Contribution>());
  const register = useCallback<Register>((id, contribution) => {
    setContributions((previous) => {
      if (!contribution && !previous.has(id)) return previous;
      const next = new Map(previous);
      if (contribution) next.set(id, contribution);
      else next.delete(id);
      return next;
    });
  }, []);
  const members = [...contributions.values()];
  const entries = mergeAttributionDetails(members.flatMap((member) => member.entries));
  return (
    <GroupContext.Provider value={register}>
      {children}
      {entries.length > 0 && (
        <Box sx={{ px: 2, py: 1, color: "text.secondary", fontSize: "0.6875rem" }}>
          <AttributionDetails entries={entries} logos={members.flatMap((member) => member.logos)} />
        </Box>
      )}
    </GroupContext.Provider>
  );
}

/** True when this section's content details are reachable through the panel action. */
export function useGroupedAttributionDetails(
  contribution: Contribution,
  enabled: boolean,
): boolean {
  const register = useContext(GroupContext);
  const id = useId();
  // Callers commonly create fresh arrays during render. Register only when the
  // captured content changes, not when this group renders its collected action.
  const snapshot = register && enabled ? JSON.stringify(contribution) : "";
  useEffect(() => {
    if (!register || !enabled) return;
    const current = JSON.parse(snapshot) as Contribution;
    if (current.entries.length === 0) return;
    register(id, current);
    return () => register(id, null);
  }, [register, id, snapshot, enabled]);
  return Boolean(register && enabled);
}
