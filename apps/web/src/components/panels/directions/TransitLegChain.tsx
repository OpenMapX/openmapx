"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { LegBadge } from "@/components/panels/transit/LegBadge";
import { summaryChainLegs } from "./transitSummary";

/** A trip's rides as a chain of line badges (U5 › S1), as its route card names it. */
export function TransitLegChain({ legs, sx }: { legs: readonly TripLeg[]; sx?: SxProps<Theme> }) {
  return (
    <Box
      sx={[
        { display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", minWidth: 0 },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {summaryChainLegs(legs).map((leg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
        <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {i > 0 && <ChevronRightIcon sx={{ fontSize: 14, color: "text.disabled" }} />}
          <LegBadge leg={leg} />
        </Box>
      ))}
    </Box>
  );
}
