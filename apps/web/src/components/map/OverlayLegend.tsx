"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { AttributionText } from "@/components/ui/AttributionText";

export interface OverlayLegendProps {
  /** Resolved title string (already translated by the caller). */
  title: string;
  /** When false the legend renders nothing (short-circuit preserved from callers). */
  panelOpen: boolean;
  /** Bound to the header toggle. */
  layerVisible: boolean;
  /** Drives the absolutely-positioned loading bar. */
  loading: boolean;
  /** Header toggle handler. */
  setLayerVisible: (visible: boolean) => void;
  /** Translated aria-label for the header toggle (e.g. t("toggleOverlay")). */
  toggleAriaLabel: string;
  /** Trusted attribution HTML from manifest dataSources; footer is omitted when falsy. */
  attributionHtml?: string | null;
  /** Per-overlay swatch / control content rendered between header and attribution. */
  children: ReactNode;
  /**
   * Extra sx merged onto the Paper shell to reproduce per-overlay variations
   * (e.g. whiteSpace: "nowrap", maxWidth). The invariant shell sx is applied first.
   */
  paperSx?: SxProps<Theme>;
  /** sx for the header Box (varies only by bottom margin across callers). */
  headerSx?: SxProps<Theme>;
  /** sx for the attribution footer Typography (varies by mt/display/fontSize). */
  attributionSx?: SxProps<Theme>;
}

/**
 * Shared shell for overlay legends: the <Paper> wrapper, absolutely-positioned
 * loading bar, the title + toggle header, and the dangerouslySetInnerHTML
 * attribution footer. The per-overlay swatch content is passed as children.
 *
 * The markup and sx values are reproduced byte-for-byte from the original
 * standalone legends; per-overlay differences (Paper extras, header margin,
 * attribution sx) are passed in as props so the rendered output is unchanged.
 */
export function OverlayLegend({
  title,
  panelOpen,
  layerVisible,
  loading,
  setLayerVisible,
  toggleAriaLabel,
  attributionHtml,
  children,
  paperSx,
  headerSx,
  attributionSx,
}: OverlayLegendProps) {
  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={[
        {
          position: "relative",
          px: 2,
          py: 1.5,
          borderRadius: "12px",
          overflow: "hidden",
        },
        ...(Array.isArray(paperSx) ? paperSx : [paperSx]),
      ]}
    >
      {loading && (
        <LinearProgress
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}
      <Box
        sx={[
          { display: "flex", alignItems: "center", justifyContent: "space-between" },
          ...(Array.isArray(headerSx) ? headerSx : [headerSx]),
        ]}
      >
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{title}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          slotProps={{ input: { "aria-label": toggleAriaLabel } }}
          sx={{ ml: 2 }}
        />
      </Box>
      {children}
      {/* Attribution (from manifest dataSources, trusted static config) */}
      {attributionHtml && (
        <Typography
          variant="caption"
          component="div"
          sx={[
            { color: "text.secondary" },
            ...(Array.isArray(attributionSx) ? attributionSx : [attributionSx]),
          ]}
        >
          <AttributionText html={attributionHtml} />
        </Typography>
      )}
    </Paper>
  );
}

export default OverlayLegend;
