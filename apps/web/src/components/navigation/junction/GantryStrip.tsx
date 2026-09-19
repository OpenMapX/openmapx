"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { GantryModel } from "@openmapx/core";

interface Props {
  model: GantryModel;
  size?: "banner" | "compact";
}

type Panel = GantryModel["panels"][number];

/** The overhead-board blue, with the active panel a shade brighter. */
const BOARD_BLUE = { bg: "#0e3464", fg: "#ffffff" };
const ACTIVE_BOARD_BLUE = { bg: "#154889", fg: "#ffffff" };

/**
 * `destination:colour` values that appear on real boards; anything else keeps
 * the motorway blue. Yellow and white boards carry dark text.
 */
const BOARD_COLOURS: Record<string, { bg: string; fg: string }> = {
  yellow: { bg: "#f4c542", fg: "#000000" },
  white: { bg: "#f5f5f5", fg: "#000000" },
  green: { bg: "#0b7a3b", fg: "#ffffff" },
  brown: { bg: "#6b4a2b", fg: "#ffffff" },
  orange: { bg: "#e8792b", fg: "#000000" },
};

/** `destination:symbol` values with a glyph a driver recognises at a glance. */
const SYMBOL_GLYPHS: Record<string, string> = {
  airport: "✈",
  industrial: "⚙",
  hospital: "✚",
  centre: "◉",
  center: "◉",
};

function panelColours(panel: Panel, active: boolean) {
  if (panel.colour && BOARD_COLOURS[panel.colour]) return BOARD_COLOURS[panel.colour];
  return active ? ACTIVE_BOARD_BLUE : BOARD_BLUE;
}

/**
 * One panel of the gantry: the exit number, the refs, then the destination
 * texts stacked as on an overhead board. The active panel is emphasised with
 * a brighter board and a light outline.
 */
function GantryPanel({
  model,
  panel,
  size,
}: {
  model: GantryModel;
  panel: Panel;
  size: "banner" | "compact";
}) {
  const active = panel.lanes.some((lane) => model.activeLanes.includes(lane));
  const colours = panelColours(panel, active);
  const glyphs = panel.symbols.map((symbol) => SYMBOL_GLYPHS[symbol]).filter(Boolean);
  return (
    <Box
      data-active={String(active)}
      data-panel
      sx={{
        flex: 1,
        minWidth: 0,
        bgcolor: colours.bg,
        color: colours.fg,
        borderRadius: 1,
        px: 0.75,
        py: 0.5,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        overflow: "hidden",
        outline: active ? "2px solid #ffffff" : "none",
        outlineOffset: -2,
      }}
    >
      {panel.exitNumber && (
        <Typography
          component="span"
          sx={{ fontSize: size === "banner" ? 12 : 10, fontWeight: 700, whiteSpace: "nowrap" }}
        >
          {panel.exitNumber}
        </Typography>
      )}
      {panel.refs.map((roadRef) => (
        <Typography
          key={roadRef}
          component="span"
          sx={{ fontSize: size === "banner" ? 11 : 9, fontWeight: 700, whiteSpace: "nowrap" }}
        >
          {roadRef}
        </Typography>
      ))}
      {panel.destinations.slice(0, 3).map((destination) => (
        <Typography
          key={destination}
          component="span"
          noWrap
          sx={{ fontSize: size === "banner" ? 11 : 9, lineHeight: 1.3, maxWidth: "100%" }}
        >
          {destination}
        </Typography>
      ))}
      {glyphs.length > 0 && (
        <Typography component="span" aria-hidden sx={{ fontSize: size === "banner" ? 12 : 10 }}>
          {glyphs.join(" ")}
        </Typography>
      )}
    </Box>
  );
}

/** The overhead gantry: one board per destination group, left to right. */
export function GantryStrip({ model, size = "banner" }: Props) {
  return (
    <Box sx={{ display: "flex", gap: 0.5, alignItems: "stretch" }}>
      {model.panels.map((panel) => (
        <GantryPanel
          key={`${panel.isExit ? "exit" : "lanes"}-${panel.lanes.join("-")}`}
          model={model}
          panel={panel}
          size={size}
        />
      ))}
    </Box>
  );
}
