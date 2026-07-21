"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { sanitizeAttributionHtml } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useTranslations } from "next-intl";
import { type JSX, useState } from "react";

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
  /**
   * When set and the deduped list exceeds it, only this many chips render by
   * default, followed by a "+N more" toggle that reveals the rest. Keeps long
   * attribution lists (e.g. a transit hub served by many feeds) compact.
   */
  maxVisible?: number;
}

function chipHref(attr: Attribution): string {
  if (attr.url) return attr.url;
  return `/licenses#source-${encodeURIComponent(attr.sourceId)}`;
}

function displayLabel(attr: Attribution): string {
  return attr.spdxLicense ? `${attr.name} · ${attr.spdxLicense}` : attr.name;
}

/**
 * Dedupe by sourceId, then collapse chips that would render identically (same
 * name + license). Distinct feeds operated by the same agency — e.g. two HAFAS
 * registry instances both crediting "Deutsche Bahn AG" — otherwise show as
 * duplicate chips even though they read the same.
 */
function dedupeForDisplay(attributions: Attribution[]): Attribution[] {
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const out: Attribution[] = [];
  for (const a of attributions) {
    if (!a?.sourceId || seenIds.has(a.sourceId)) continue;
    seenIds.add(a.sourceId);
    const label = displayLabel(a);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    out.push(a);
  }
  return out;
}

/**
 * AttributionStrip — the compact chip presentation for data-source attribution,
 * used by the over-the-wire, multi-source paths (transit, directions, geocoding
 * search, reviews). Consumes `MobilityResult.attributions[]` and renders one
 * chip per source (name plus, where present, SPDX license), with the full
 * builder-produced credit in the hover tooltip.
 *
 * This is the ONE deliberate divergence from the shared inline renderer: chips
 * are compact and intentionally `©`-less — a dense list of feeds should not
 * repeat `©` per chip, and the copyright obligation is discharged by the inline
 * captions (`SectionAttribution`/`AttributionText`), the overlay legends, the
 * `/terms` tables, and the map credit. Every non-chip surface renders through
 * `buildAttributionHtml` via `AttributionText`; do not re-add `©` here or fork a
 * second inline renderer.
 *
 * Returns `null` when there are no attributions to render so callers can render
 * unconditionally.
 */
export function AttributionStrip({
  attributions,
  variant = "inline",
  label,
  navigable = true,
  maxVisible,
}: AttributionStripProps): JSX.Element | null {
  const tc = useTranslations("common");
  const [expanded, setExpanded] = useState(false);
  if (!attributions || attributions.length === 0) return null;
  const items = dedupeForDisplay(attributions);
  if (items.length === 0) return null;

  const isPanelHeader = variant === "panel-header";
  const collapsible = typeof maxVisible === "number" && items.length > maxVisible;
  const visibleItems = collapsible && !expanded ? items.slice(0, maxVisible) : items;
  const hiddenCount = items.length - visibleItems.length;

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
      {visibleItems.map((attr, idx) => {
        const labelText = displayLabel(attr);
        const tooltip = attr.attributionText ? (
          <Box
            component="span"
            sx={{ "& a": { color: "inherit" } }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the shared allowlist sanitizer keeps only safe attribution links and text
            dangerouslySetInnerHTML={{ __html: sanitizeAttributionHtml(attr.attributionText) }}
          />
        ) : (
          (attr.publisher?.name ?? attr.url ?? attr.name)
        );
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
      {collapsible && (
        <Typography
          component="button"
          type="button"
          onClick={() => setExpanded((v) => !v)}
          sx={{
            border: 0,
            background: "none",
            cursor: "pointer",
            p: 0,
            fontFamily: "inherit",
            fontSize,
            lineHeight: 1.4,
            fontWeight: 500,
            color: "text.secondary",
            "&:hover": { textDecoration: "underline" },
          }}
        >
          {expanded ? tc("showLess") : tc("showMore", { count: hiddenCount })}
        </Typography>
      )}
    </Box>
  );
}
