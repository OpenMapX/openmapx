"use client";

import Box from "@mui/material/Box";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { AttributionStrip } from "./AttributionStrip";

/** Section credits use the same captured policies and complete details as other content. */
export function SectionAttribution({
  attributions,
  inset = false,
}: {
  attributions: readonly Attribution[];
  inset?: boolean;
}) {
  if (!attributions.length) return null;
  const credits = <AttributionStrip attributions={[...attributions]} variant="plain" />;
  return inset ? <Box sx={{ px: 2, py: 1 }}>{credits}</Box> : credits;
}
