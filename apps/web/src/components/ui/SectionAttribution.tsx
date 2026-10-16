"use client";

import Box from "@mui/material/Box";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { AttributionStrip } from "./AttributionStrip";
import { useAttributionGroupPlacement } from "./attributionGroupContext";

/** Section credits use the same captured policies and complete details as other content. */
export function SectionAttribution({
  attributions,
  inset = false,
  keepVisibleWithContent = false,
}: {
  attributions: readonly Attribution[];
  inset?: boolean;
  keepVisibleWithContent?: boolean;
}) {
  const placement = useAttributionGroupPlacement();
  if (!attributions.length) return null;
  const credits = (
    <AttributionStrip
      attributions={[...attributions]}
      variant="plain"
      keepVisibleWithContent={keepVisibleWithContent}
    />
  );
  return inset && (placement !== "footer" || keepVisibleWithContent) ? (
    <Box sx={{ px: 2, py: 1 }}>{credits}</Box>
  ) : (
    credits
  );
}
