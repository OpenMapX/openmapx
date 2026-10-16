"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  type AttributionDetail,
  buildAttributionPresentation,
  buildRuntimeAttributionHtml,
  mergeAttributionDetails,
  projectAttributionPresentations,
  safeHref,
} from "@openmapx/core";
import type { VisibleAttribution } from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import {
  type AttributionLogo,
  type AttributionSurface,
  DISPLAY_LICENSE_SCOPES,
  formatLicensing,
} from "@openmapx/mobility-core/licensing";
import { useTranslations } from "next-intl";
import { type JSX, useState } from "react";
import { AttributionDetails } from "./AttributionDetails";
import { AttributionNotices } from "./AttributionNotices";
import { useGroupedAttributionDetails } from "./attributionGroupContext";

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
  /** Keep required notices beside a widget when its provider requires adjacency. */
  keepVisibleWithContent?: boolean;
  /** Captured panel details retained independently of deduplicated visible notices. */
  additionalDetails?: readonly AttributionDetail[];
  /** Required branding retained by a grouped dialog when a widget stays adjacent. */
  additionalLogos?: readonly AttributionLogo[];
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
  keepVisibleWithContent = false,
  additionalDetails = [],
  additionalLogos = [],
  color,
}: AttributionStripProps): JSX.Element | null {
  const tc = useTranslations("common");
  const [expanded, setExpanded] = useState(false);
  const items = dedupeForDisplay(attributions ?? []);

  const isPanelHeader = variant === "panel-header";
  const isPlain = variant === "plain";
  const presentations = items.map((attr) => buildAttributionPresentation(attr, surface));
  const group = presentations.length
    ? projectAttributionPresentations(presentations)
    : { details: [], visible: [] };
  const logos = group.visible.flatMap((notice) => notice.logos);
  const grouped = useGroupedAttributionDetails(
    {
      attributions: keepVisibleWithContent
        ? items.filter((_, index) => !presentations[index]?.visibleHtml)
        : items,
      entries: group.details,
      logos,
    },
    surface === "content",
  );
  if (
    (items.length === 0 && additionalDetails.length === 0) ||
    (grouped === "footer" && !keepVisibleWithContent)
  )
    return null;
  const showOptional =
    provenanceDisplay === "chips" && !(grouped === "footer" && keepVisibleWithContent);
  const optional = new Map<string, Attribution>();
  for (const [index, attr] of items.entries()) {
    if (presentations[index]?.visibleHtml) continue;
    // Full receipts remain in group.details; identical optional source labels
    // need only one link even when their software grants or capture notes differ.
    const key = JSON.stringify([displayLabel(attr), safeHref(attr.url)]);
    if (!optional.has(key)) optional.set(key, attr);
  }
  const eligible = [...optional.values()];
  const collapsible =
    showOptional && typeof maxVisible === "number" && eligible.length > maxVisible;
  const selected = new Set(
    !showOptional
      ? []
      : collapsible && !expanded
        ? eligible.slice(0, Math.max(0, maxVisible))
        : eligible,
  );
  const visibleItems: { attr?: Attribution; notice?: VisibleAttribution; key: string }[] = [
    ...group.visible.map((notice) => ({
      notice,
      attr: items.find((_, index) => presentations[index]?.visibleHtml === notice.html),
      key: `notice:${notice.html}`,
    })),
    ...eligible
      .filter((attr) => selected.has(attr))
      .map((attr) => ({
        attr,
        key: `source:${contributorKey(attr)}`,
      })),
  ];
  const hiddenCount = eligible.length - selected.size;

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
      {visibleItems.map(({ attr, notice, key }, idx) => {
        const mandatory = notice !== undefined;
        const labelText = attr ? displayLabel(attr) : "";
        const link = attr ? chipHref(attr) : undefined;
        const tooltip = (
          <Box
            component="span"
            sx={{ "& a": { color: "inherit" } }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shared attribution sanitizer escapes captured metadata
            dangerouslySetInnerHTML={{
              __html: attr ? buildRuntimeAttributionHtml(attr) : (notice?.html ?? ""),
            }}
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
          <Box component="span" sx={chipSx} data-source-id={attr?.sourceId}>
            {mandatory ? <AttributionNotices notices={notice ? [notice] : []} /> : labelText}
          </Box>
        );
        const node =
          navigable &&
          link &&
          (!notice || (!notice.html.includes("<a ") && notice.logos.length === 0)) ? (
            <Link
              key={key}
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
            <Box key={key} component="span" sx={fitSx}>
              {chipContent}
            </Box>
          );
        return (
          <Box key={key} component="span" sx={{ minWidth: 0, overflowWrap: "anywhere", ...fitSx }}>
            <Tooltip title={tooltip} placement="top" arrow>
              <Box
                component="span"
                sx={{ display: isPlain ? "inline" : "inline-flex", ...fitSx }}
                data-idx={idx}
              >
                {node}
              </Box>
            </Tooltip>
            {isPlain && idx < visibleItems.length - 1 && (
              <Box component="span" aria-hidden sx={{ color: "text.disabled", ml: 0.5 }}>
                |
              </Box>
            )}
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
      {!grouped && (
        <AttributionDetails
          entries={mergeAttributionDetails([...group.details, ...additionalDetails])}
          logos={[...logos, ...additionalLogos]}
        />
      )}
    </Box>
  );
}
