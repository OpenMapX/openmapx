"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import { mergeAttributionDetails } from "@openmapx/core/attribution";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { AttributionDetails } from "./AttributionDetails";
import { AttributionStrip } from "./AttributionStrip";
import {
  AttributionGroupContext,
  type AttributionGroupContribution,
  type AttributionGroupPlacement,
} from "./attributionGroupContext";

/**
 * Mounted content owns its captured receipts, including when tabs/place change.
 * By default only the details action is shared. Panels can explicitly collect
 * complete content credits in one footer; image credits always stay image-bound.
 */
export function AttributionDetailsGroup({
  children,
  placement = "details",
  label,
  footerSx,
}: {
  children: ReactNode;
  placement?: AttributionGroupPlacement;
  label?: string;
  /** Match an already padded content owner without adding a second gutter. */
  footerSx?: SxProps<Theme>;
}) {
  const [contributions, setContributions] = useState(
    new Map<string, AttributionGroupContribution>(),
  );
  const register = useCallback((id: string, contribution: AttributionGroupContribution | null) => {
    setContributions((previous) => {
      if (!contribution && !previous.has(id)) return previous;
      const next = new Map(previous);
      if (contribution) next.set(id, contribution);
      else next.delete(id);
      return next;
    });
  }, []);
  const context = useMemo(() => ({ register, placement }), [register, placement]);
  const members = [...contributions.values()];
  const entries = mergeAttributionDetails(members.flatMap((member) => member.entries));
  return (
    <>
      <AttributionGroupContext.Provider value={context}>
        {children}
      </AttributionGroupContext.Provider>
      {/* The footer must not register its own receipts (or join an outer panel). */}
      <AttributionGroupContext.Provider value={null}>
        {entries.length > 0 && (
          <Box
            sx={[
              ...(label ? [] : [{ px: 2, py: 1, color: "text.secondary", fontSize: "0.6875rem" }]),
              ...(Array.isArray(footerSx) ? footerSx : footerSx ? [footerSx] : []),
            ]}
          >
            {placement === "footer" ? (
              <AttributionStrip
                attributions={members.flatMap((member) => member.attributions)}
                variant={label ? "panel-header" : "plain"}
                label={label}
                additionalDetails={entries}
                additionalLogos={members.flatMap((member) => member.logos)}
              />
            ) : (
              <AttributionDetails
                entries={entries}
                logos={members.flatMap((member) => member.logos)}
              />
            )}
          </Box>
        )}
      </AttributionGroupContext.Provider>
    </>
  );
}
