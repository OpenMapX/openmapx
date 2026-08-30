"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

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
  /** Per-overlay swatch / control content rendered below the header. */
  children: ReactNode;
  /**
   * Extra sx merged onto the Paper shell to reproduce per-overlay variations
   * (e.g. whiteSpace: "nowrap", maxWidth). The invariant shell sx is applied first.
   */
  paperSx?: SxProps<Theme>;
  /** sx for the header Box (varies only by bottom margin across callers). */
  headerSx?: SxProps<Theme>;
  /**
   * sx merged onto the title Typography. Only needed by legends whose title is
   * dynamic and has to be constrained (the weather legend interpolates a place
   * name and truncates it).
   */
  titleSx?: SxProps<Theme>;
}

/**
 * Shared shell for every overlay legend: the <Paper> wrapper,
 * absolutely-positioned loading bar, and the title + toggle header. The
 * per-overlay swatch content is passed as children.
 *
 * Per-overlay differences (Paper extras, header margin, title constraints) are
 * passed in as props, so a legend keeps its own look while the shell lives
 * here. The overlay tools (measurement, travel time) deliberately stay
 * standalone: they are toolbars with a close button, not legends with a
 * visibility toggle.
 *
 * Legends carry no credits. An overlay's sources are credited once, in the map
 * credits strip (`<MapFooter>`), which every layer registers into via
 * `useMapAttributions` and which renders the same "Publisher (License)" HTML
 * these legends used to duplicate.
 */
export function OverlayLegend({
  title,
  panelOpen,
  layerVisible,
  loading,
  setLayerVisible,
  toggleAriaLabel,
  children,
  paperSx,
  headerSx,
  titleSx,
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
            "@media (prefers-reduced-motion: reduce)": {
              "& .MuiLinearProgress-bar": { animation: "none", transition: "none" },
            },
          }}
        />
      )}
      <Box
        sx={[
          { display: "flex", alignItems: "center", justifyContent: "space-between" },
          ...(Array.isArray(headerSx) ? headerSx : [headerSx]),
        ]}
      >
        <Typography
          sx={[
            { fontWeight: 600, fontSize: 14 },
            ...(Array.isArray(titleSx) ? titleSx : [titleSx]),
          ]}
        >
          {title}
        </Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          slotProps={{ input: { "aria-label": toggleAriaLabel } }}
          sx={{ ml: 2 }}
        />
      </Box>
      {children}
    </Paper>
  );
}

export default OverlayLegend;
