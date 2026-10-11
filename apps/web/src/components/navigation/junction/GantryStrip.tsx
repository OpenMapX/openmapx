"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { cleanSignTexts, exitNumberLabel, type GantryModel } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { laneIndicationIcon } from "@/lib/navigation/maneuverIcon";
import { RouteShield } from "../signs/RouteShield";

interface Props {
  model: GantryModel;
  country?: string;
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

function Direction({ turn }: { turn?: string }) {
  const icon = turn ? laneIndicationIcon(turn)?.component : undefined;
  if (!icon) return null;
  const Icon = icon;
  return <Icon aria-hidden sx={{ fontSize: 26, flexShrink: 0 }} />;
}

function GantryPanel({
  model,
  panel,
  size,
  grid,
  country,
}: {
  model: GantryModel;
  panel: Panel;
  size: "banner" | "compact";
  grid: boolean;
  country?: string;
}) {
  const branch = model.branches?.find((entry) => entry.wayId === panel.branchWayId);
  const active = branch ? branch.selected : panel.isExit;
  const colours = panelColours(panel, active);
  const glyphs = panel.symbols.map((symbol) => SYMBOL_GLYPHS[symbol]).filter(Boolean);
  const refs = cleanSignTexts(panel.refs, true);
  const destinations = cleanSignTexts(panel.destinations);
  const first = panel.lanes[0];
  const last = panel.lanes.at(-1);
  return (
    <Box
      data-active={String(active)}
      data-panel
      data-lane-span={first !== undefined && last !== undefined ? `${first}-${last}` : undefined}
      sx={{
        gridColumn:
          grid && first !== undefined && last !== undefined
            ? `${first + 1} / ${last + 2}`
            : undefined,
        flex: grid ? undefined : "1 1 140px",
        minWidth: 0,
        bgcolor: colours.bg,
        color: colours.fg,
        borderRadius: 1,
        p: 0.75,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.25,
        border: active ? "2px solid #ffffff" : "2px solid transparent",
      }}
    >
      {exitNumberLabel(panel.exitNumber) && (
        <Typography component="span" sx={{ fontSize: 14, fontWeight: 700 }}>
          {exitNumberLabel(panel.exitNumber)}
        </Typography>
      )}
      <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", justifyContent: "center" }}>
        {refs.map((roadRef) => (
          <RouteShield key={roadRef} roadRef={roadRef} country={country} size={size} />
        ))}
      </Box>
      {destinations.slice(0, active ? 2 : 1).map((destination) => (
        <Typography
          key={destination}
          component="span"
          sx={{
            fontSize: size === "banner" ? 14 : 12,
            lineHeight: 1.25,
            textAlign: "center",
            overflowWrap: "anywhere",
            maxWidth: "100%",
          }}
        >
          {destination}
        </Typography>
      ))}
      <Direction turn={panel.turn} />
      {glyphs.length > 0 && (
        <Typography component="span" aria-hidden sx={{ fontSize: 14 }}>
          {glyphs.join(" ")}
        </Typography>
      )}
    </Box>
  );
}

/** Only known, nonoverlapping incoming spans form a spatial gantry. */
export function GantryStrip({ model, size = "banner", country }: Props) {
  const t = useTranslations("navigation");
  const selected = model.selectedRoute ?? model.panels.find((panel) => panel.isExit);
  const occupied = new Set<number>();
  const grid =
    model.laneCount > 0 &&
    model.panels.length > 0 &&
    model.panels.every(
      (panel) =>
        panel.lanes.length > 0 &&
        panel.lanes.every((lane, i) => {
          if (
            lane < 0 ||
            lane >= model.laneCount ||
            occupied.has(lane) ||
            (i > 0 && lane !== panel.lanes[i - 1] + 1)
          )
            return false;
          occupied.add(lane);
          return true;
        }),
    );
  const refs = cleanSignTexts(selected?.refs ?? [], true);
  const destinations = cleanSignTexts(selected?.destinations ?? []);
  const exitNumber = exitNumberLabel(selected?.exitNumber);
  const showTitle = refs.length > 0 || destinations.length > 0 || !!exitNumber;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {showTitle && (
        <Box
          data-selected-route
          sx={{
            bgcolor: ACTIVE_BOARD_BLUE.bg,
            color: "#fff",
            borderRadius: 1.5,
            px: 1.25,
            py: 1,
            borderInlineStart: "4px solid #fff",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Direction turn={selected?.turn} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
              {t("junctionFollowRoute")}
              {exitNumber ? ` · ${t("exitNumber", { number: exitNumber })}` : ""}
            </Typography>
            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", my: 0.25 }}>
              {refs.map((ref) => (
                <RouteShield key={ref} roadRef={ref} country={country} size={size} />
              ))}
            </Box>
            {destinations.slice(0, 2).map((destination) => (
              <Typography
                key={destination}
                sx={{
                  fontSize: size === "banner" ? 18 : 14,
                  lineHeight: 1.25,
                  overflowWrap: "anywhere",
                }}
              >
                {destination}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
      <Box
        data-layout={grid ? "lane-grid" : "route-card"}
        sx={{
          display: grid ? "grid" : "flex",
          gridTemplateColumns: grid ? `repeat(${model.laneCount}, minmax(0, 1fr))` : undefined,
          flexWrap: "wrap",
          gap: 0.5,
          alignItems: "stretch",
        }}
      >
        {model.panels.map((panel) => (
          <GantryPanel
            key={JSON.stringify([
              panel.branchWayId,
              panel.lanes,
              panel.refs,
              panel.destinations,
              panel.isExit,
            ])}
            model={model}
            panel={panel}
            size={size}
            grid={grid}
            country={country}
          />
        ))}
      </Box>
    </Box>
  );
}
