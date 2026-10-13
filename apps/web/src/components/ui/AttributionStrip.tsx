"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { buildRuntimeAttributionHtml, safeHref } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import { DISPLAY_LICENSE_SCOPES, formatLicensing } from "@openmapx/mobility-core/licensing";
import { useTranslations } from "next-intl";
import { type JSX, useState } from "react";

/**
 * Visual variant for the AttributionStrip.
 *
 * - `inline`: small chips inline with surrounding text (~11px, muted).
 * - `panel-header`: top of a panel, with optional label and a divider underneath.
 * - `plain`: wrapping linked text for compact result headers.
 */
export type AttributionStripVariant = "inline" | "panel-header" | "plain";

export interface AttributionStripProps {
  /** Attributions to render, typically from MobilityResult.attributions. */
  attributions: Attribution[] | null | undefined;
  /** Visual variant. */
  variant?: AttributionStripVariant;
  /** Optional visible label for `panel-header` and accessible label for `plain`. */
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

/** The external credit URL when safe to follow, or the in-app licenses anchor. */
function chipHref(attr: Attribution): { href: string; external: boolean } {
  const external = safeHref(attr.url);
  if (external) return { href: external, external: true };
  return { href: `/licenses#source-${encodeURIComponent(attr.sourceId)}`, external: false };
}

/**
 * Longest license that still reads as a chip suffix. Identifiers and short
 * labels ("CC-BY-4.0", "NLOD 2.0", "U.S. Public Domain") fit; qualified
 * descriptions ("Mixed (per upstream GTFS/GBFS feed; mostly open data)") move
 * to the tooltip instead of stretching the chip across the panel.
 */
const MAX_CHIP_LICENSE_LENGTH = 24;

function license(attr: Attribution): string | undefined {
  return attr.licensing
    ? formatLicensing(attr.licensing, { scopes: DISPLAY_LICENSE_SCOPES }) || undefined
    : undefined;
}

function chipLicense(attr: Attribution): string | undefined {
  const text = license(attr);
  return text && text.length <= MAX_CHIP_LICENSE_LENGTH ? text : undefined;
}

function displayLabel(attr: Attribution): string {
  const text = chipLicense(attr);
  return text ? `${attr.name} · ${text}` : attr.name;
}

/** Collapse identical displayed receipts, preserving every distinct required notice. */
function dedupeForDisplay(attributions: Attribution[]): Attribution[] {
  const seen = new Set<string>();
  return attributions.filter((receipt) => {
    if (!receipt?.sourceId) return false;
    // Multiple feeds can credit the same agency. Their full credit, links and
    // license must match before one presentation can discharge both receipts.
    const key = contributorKey({ ...receipt, sourceId: "" });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const isPlain = variant === "plain";
  const collapsible = typeof maxVisible === "number" && items.length > maxVisible;
  const visibleItems = collapsible && !expanded ? items.slice(0, maxVisible) : items;
  const hiddenCount = items.length - visibleItems.length;

  const containerSx = {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: isPlain ? 0.5 : 0.75,
    minWidth: 0,
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
    <Box
      sx={containerSx}
      role="contentinfo"
      aria-label={isPlain ? (label ?? "Data sources") : "Data sources"}
    >
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
        const link = chipHref(attr);
        const tooltip = (
          <Box
            component="span"
            sx={{ "& a": { color: "inherit" } }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shared attribution sanitizer escapes captured metadata
            dangerouslySetInnerHTML={{ __html: buildRuntimeAttributionHtml(attr) }}
          />
        );
        // Every box from the strip down to the chip is capped at the strip's
        // width, so a chip too long for the panel ends in an ellipsis instead
        // of running past the panel edge.
        const fitSx = isPlain ? {} : { display: "flex", minWidth: 0, maxWidth: "100%" };
        const chipSx = {
          display: isPlain ? "inline" : "block",
          fontSize,
          lineHeight: 1.4,
          color: "text.secondary",
          ...(!isPlain && {
            backgroundColor: "action.hover",
            px: 0.75,
            py: 0.25,
            borderRadius: 0.75,
          }),
          maxWidth: "100%",
          whiteSpace: isPlain ? ("normal" as const) : ("nowrap" as const),
          overflowWrap: isPlain ? ("anywhere" as const) : undefined,
          ...(!isPlain && { overflow: "hidden", textOverflow: "ellipsis" }),
        };
        const chipContent = (
          <Box component="span" sx={chipSx} data-source-id={attr.sourceId}>
            {labelText}
          </Box>
        );
        const node = navigable ? (
          <Link
            key={contributorKey(attr)}
            href={link.href}
            target={link.external ? "_blank" : undefined}
            rel={link.external ? "noopener noreferrer" : undefined}
            underline="hover"
            sx={{
              color: "inherit",
              textDecoration: "none",
              overflowWrap: isPlain ? "anywhere" : undefined,
              ...fitSx,
            }}
          >
            {chipContent}
          </Link>
        ) : (
          <Box key={contributorKey(attr)} component="span" sx={fitSx}>
            {chipContent}
          </Box>
        );
        return (
          <Box
            key={contributorKey(attr)}
            component="span"
            sx={{ minWidth: 0, overflowWrap: "anywhere", ...fitSx }}
          >
            {isPlain && idx > 0 && (
              <Box component="span" sx={{ color: "text.disabled", mr: 0.5 }}>
                ·
              </Box>
            )}
            <Tooltip title={tooltip} placement="top" arrow>
              <Box
                component="span"
                sx={{ display: isPlain ? "inline" : "inline-flex", ...fitSx }}
                data-idx={idx}
              >
                {node}
              </Box>
            </Tooltip>
          </Box>
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
