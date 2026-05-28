"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { JSX } from "react";

/**
 * Visual variant for the AttributionStrip.
 *
 * - `inline`: small chips inline with surrounding text (~11px, muted).
 * - `panel-header`: top of a panel, with optional label and a divider underneath.
 */
export type AttributionStripVariant = "inline" | "panel-header";

export interface AttributionStripProps {
  /** Attributions to render, typically from MobilityResult.attributions. */
  attributions: Attribution[] | null | undefined;
  /** Visual variant. */
  variant?: AttributionStripVariant;
  /** Optional label prefixed to the chips (rendered for `panel-header`). */
  label?: string;
  /**
   * When true (default), each chip is a link:
   *   - Prefer the attribution's own `url` (canonical homepage / data portal)
   *   - Fall back to the in-app `/licenses` page anchored to this sourceId.
   */
  navigable?: boolean;
}

function chipHref(attr: Attribution): string {
  if (attr.url) return attr.url;
  return `/licenses#source-${encodeURIComponent(attr.sourceId)}`;
}

function dedupBySourceId(attributions: Attribution[]): Attribution[] {
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const a of attributions) {
    if (!a?.sourceId || seen.has(a.sourceId)) continue;
    seen.add(a.sourceId);
    out.push(a);
  }
  return out;
}

/**
 * AttributionStrip — the single rendering path for data-source attribution
 * across the app. Consumes a `MobilityResult.attributions[]` and renders one
 * compact chip per source (name plus, where present, SPDX license).
 *
 * Returns `null` when there are no attributions to render so callers can render
 * unconditionally.
 */
export function AttributionStrip({
  attributions,
  variant = "inline",
  label,
  navigable = true,
}: AttributionStripProps): JSX.Element | null {
  if (!attributions || attributions.length === 0) return null;
  const items = dedupBySourceId(attributions);
  if (items.length === 0) return null;

  const isPanelHeader = variant === "panel-header";

  const containerSx = {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: 0.75,
    ...(isPanelHeader
      ? {
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
        }
      : {}),
  };

  const fontSize = isPanelHeader ? "0.75rem" : "0.6875rem";

  return (
    <Box sx={containerSx} role="contentinfo" aria-label="Data sources">
      {label && isPanelHeader && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            fontSize,
            fontWeight: 500,
            mr: 0.5,
          }}
        >
          {label}
        </Typography>
      )}
      {items.map((attr, idx) => {
        const labelText = attr.spdxLicense ? `${attr.name} · ${attr.spdxLicense}` : attr.name;
        const tooltip = attr.attributionText ?? attr.publisher?.name ?? attr.url ?? attr.name;
        const chipSx = {
          display: "inline-flex",
          alignItems: "center",
          fontSize,
          lineHeight: 1.4,
          color: "text.secondary",
          backgroundColor: "action.hover",
          px: 0.75,
          py: 0.25,
          borderRadius: 0.75,
          maxWidth: "100%",
          whiteSpace: "nowrap" as const,
          overflow: "hidden",
          textOverflow: "ellipsis",
        };
        const chipContent = (
          <Box component="span" sx={chipSx} data-source-id={attr.sourceId}>
            {labelText}
          </Box>
        );
        const node = navigable ? (
          <Link
            key={attr.sourceId}
            href={chipHref(attr)}
            target={attr.url ? "_blank" : undefined}
            rel={attr.url ? "noopener noreferrer" : undefined}
            underline="hover"
            sx={{ color: "inherit", textDecoration: "none" }}
          >
            {chipContent}
          </Link>
        ) : (
          <Box key={attr.sourceId} component="span">
            {chipContent}
          </Box>
        );
        return (
          <Tooltip key={attr.sourceId} title={tooltip} placement="top" arrow>
            <Box component="span" sx={{ display: "inline-flex" }} data-idx={idx}>
              {node}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
