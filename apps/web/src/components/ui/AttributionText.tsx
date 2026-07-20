"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";

export interface AttributionTextProps {
  /**
   * Attribution HTML produced by the shared core builders — `buildAttributionHtml`,
   * `buildRuntimeAttributionHtml`, `buildSourceAttribution`, or
   * `buildIntegrationAttribution`. Those self-escape text, validate URLs, and
   * sanitize any manifest override, so the string is safe to inject. Never pass
   * unbuilt or user-supplied HTML here.
   */
  html: string;
  /** Extra styling merged onto the wrapper span. */
  sx?: SxProps<Theme>;
}

/**
 * The single inline presentation for attribution HTML. Renders an inline span
 * whose links inherit the surrounding text colour. Every non-chip attribution
 * surface — place-panel captions, the data-source footer, overlay legends —
 * renders through this, so the `©`/format live only in the core builder and the
 * link styling is defined once. The pill chips in `AttributionStrip` are the
 * deliberate exception: compact and `©`-less by design.
 */
export function AttributionText({ html, sx }: AttributionTextProps) {
  return (
    <Box
      component="span"
      sx={[
        {
          "& a": {
            color: "inherit",
            textDecoration: "none",
            "&:hover": { textDecoration: "underline" },
          },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html comes from the core attribution builders, which self-escape text, validate URLs, and sanitize manifest overrides
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
