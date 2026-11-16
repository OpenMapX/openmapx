"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { createContext, type ReactNode, useContext } from "react";

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
  /** Translated aria-label for the header toggle, such as the overlay's own "Toggle …" string. */
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
 * Set by the map's legend host when it frames the legends itself (one card,
 * one legend at a time, chosen by a tab named `label`). A legend then renders
 * flat inside that card, with no surface, shadow or width of its own, leaves
 * out a title that only repeats its tab, and ends its header with the card's
 * own `action` when there is no tab row to carry it.
 */
export const EmbeddedLegendContext = createContext<{
  label: string | null;
  action?: ReactNode;
} | null>(null);

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
 * The shell does not own map credits. Layers register captured receipts through
 * the shared rendered geometry/raster/marker tracker for `<MapFooter>`. A legend
 * that displays fetched content separately owns that content's projected receipts;
 * opening or closing it does not control the map's attribution.
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
  const t = useTranslations("map");
  const embedded = useContext(EmbeddedLegendContext);
  if (!panelOpen) return null;
  const titleShown = !embedded?.label || embedded.label !== title;

  return (
    <Paper
      elevation={embedded ? 0 : 3}
      sx={[
        {
          position: "relative",
          px: 2,
          py: 1.5,
          borderRadius: embedded ? 0 : "12px",
          overflow: "hidden",
          bgcolor: embedded ? "transparent" : undefined,
        },
        // The host's card sets the width a framed legend fills.
        ...(embedded ? [] : Array.isArray(paperSx) ? paperSx : [paperSx]),
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
        {titleShown ? (
          <Typography
            sx={[
              { fontWeight: 600, fontSize: 14 },
              ...(Array.isArray(titleSx) ? titleSx : [titleSx]),
            ]}
          >
            {title}
          </Typography>
        ) : (
          <Typography sx={{ fontSize: 14, color: "text.secondary" }}>
            {t("legendShowOnMap")}
          </Typography>
        )}
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          slotProps={{ input: { "aria-label": toggleAriaLabel } }}
          sx={{ ml: 2 }}
        />
        {embedded?.action}
      </Box>
      {children}
    </Paper>
  );
}

export default OverlayLegend;
