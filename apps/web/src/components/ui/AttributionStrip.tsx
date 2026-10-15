"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  buildAttributionPresentation,
  buildRuntimeAttributionHtml,
  projectAttributionPresentations,
  safeHref,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import {
  type AttributionSurface,
  DISPLAY_LICENSE_SCOPES,
  formatLicensing,
} from "@openmapx/mobility-core/licensing";
import { useTranslations } from "next-intl";
import { type JSX, useState } from "react";
import { AttributionDetails } from "./AttributionDetails";
import { AttributionNotices } from "./AttributionNotices";

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
   * Limits eligible optional provenance chips; mandatory notices always render.
   * When the eligible list exceeds it, only this many optional chips render by
   * default, followed by a "+N more" toggle that reveals the rest. Keeps long
   * attribution lists (e.g. a transit hub served by many feeds) compact.
   */
  maxVisible?: number;
  /** Keep optional provenance in the one-action dialog; required notices remain visible. */
  provenanceDisplay?: "chips" | "details";
  /** The actual context of the contributed data; image policies remain image-bound. */
  surface?: AttributionSurface;
  /** Contextual contrast, for example white credits on an image. */
  color?: string;
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
  return text ? `${attr.name} | ${text}` : attr.name;
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
 * Canonical content/image credits. Mandatory notices and approved branding are
 * always adjacent; maxVisible limits only optional provenance chips. Complete
 * current wording, authors, grants and links are one keyboard/touch action away.
 */
export function AttributionStrip({
  attributions,
  variant = "inline",
  label,
  navigable = true,
  maxVisible,
  provenanceDisplay = "chips",
  surface = "content",
  color,
}: AttributionStripProps): JSX.Element | null {
  const tc = useTranslations("common");
  const [expanded, setExpanded] = useState(false);
  if (!attributions || attributions.length === 0) return null;
  const items = dedupeForDisplay(attributions);
  if (items.length === 0) return null;

  const isPanelHeader = variant === "panel-header";
  const isPlain = variant === "plain";
  const presentations = items.map((attr) => buildAttributionPresentation(attr, surface));
  const group = projectAttributionPresentations(presentations);
  const eligible = items.filter((_, index) => !presentations[index]?.visibleHtml);
  const collapsible =
    provenanceDisplay === "chips" && typeof maxVisible === "number" && eligible.length > maxVisible;
  const selected = new Set(
    provenanceDisplay === "details"
      ? []
      : collapsible && !expanded
        ? eligible.slice(0, Math.max(0, maxVisible))
        : eligible,
  );
  const visibleItems = items.filter(
    (attr, index) => presentations[index]?.visibleHtml || selected.has(attr),
  );
  const hiddenCount = items.length - visibleItems.length;

  const containerSx = {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: isPlain ? 0.5 : 0.75,
    minWidth: 0,
    fontSize: isPanelHeader ? "0.75rem" : "0.6875rem",
    color: color ?? "text.secondary",
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
            color: color ?? "text.secondary",
            fontSize,
            fontWeight: 500,
            mr: 0.5,
          }}
        >
          {label}
        </Typography>
      )}
      {visibleItems.map((attr, idx) => {
        const presentation = presentations[items.indexOf(attr)]!;
        const mandatory = Boolean(presentation.visibleHtml);
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
          color: color ?? "text.secondary",
          ...(!isPlain && {
            backgroundColor: "action.hover",
            px: 0.75,
            py: 0.25,
            borderRadius: 0.75,
          }),
          maxWidth: "100%",
          whiteSpace: isPlain || mandatory ? ("normal" as const) : ("nowrap" as const),
          overflowWrap: isPlain || mandatory ? ("anywhere" as const) : undefined,
          ...(!isPlain && !mandatory && { overflow: "hidden", textOverflow: "ellipsis" }),
        };
        const chipContent = (
          <Box component="span" sx={chipSx} data-source-id={attr.sourceId}>
            {mandatory ? (
              <AttributionNotices
                notices={[
                  {
                    html: presentation.visibleHtml,
                    logos: presentation.logos,
                    prominence: presentation.prominence,
                  },
                ]}
              />
            ) : (
              labelText
            )}
          </Box>
        );
        const node =
          navigable &&
          (!mandatory ||
            (!presentation.visibleHtml.includes("<a ") && presentation.logos.length === 0)) ? (
            <Link
              key={contributorKey(attr)}
              onClick={(event) => event.stopPropagation()}
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
                |
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
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((v) => !v);
          }}
          sx={{
            border: 0,
            background: "none",
            cursor: "pointer",
            p: 0,
            fontFamily: "inherit",
            fontSize,
            lineHeight: 1.4,
            fontWeight: 500,
            color: color ?? "text.secondary",
            "&:hover": { textDecoration: "underline" },
          }}
        >
          {expanded ? tc("showLess") : tc("showMore", { count: hiddenCount })}
        </Typography>
      )}
      <AttributionDetails
        entries={group.details}
        logos={group.visible.flatMap((notice) => notice.logos)}
      />
    </Box>
  );
}
