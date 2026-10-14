"use client";

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { AttributionStrip } from "./AttributionStrip";

/** Section credits use the same captured policies and complete details as other content. */
export function SectionAttribution({ attributions }: { attributions: readonly Attribution[] }) {
  return <AttributionStrip attributions={[...attributions]} variant="plain" />;
}
