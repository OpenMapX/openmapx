"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  buildJunctionSchematic,
  type GantryModel,
  type JunctionDecisionPoint,
  type LngLat,
  signHeadline,
  visibleToward,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { JunctionPhotoState } from "@/lib/navigation/junctionStore";
import { GantryStrip } from "./GantryStrip";
import { JunctionPhoto } from "./JunctionPhoto";
import { JunctionSchematicView } from "./JunctionSchematic";

interface Props {
  point: JunctionDecisionPoint;
  /** The gantry fetched from OSM, when available; otherwise an engine-only model is built. */
  gantry?: GantryModel;
  /** The prefetched photo for this decision point, when one qualified. */
  photo?: JunctionPhotoState;
  /** The route being driven, for projecting the path ahead onto the photo. */
  geometry?: LngLat[];
}

/**
 * The engine-only gantry, shown until real OSM lane tags arrive: the exit
 * panel drawn from the engine sign over the lanes the engine marked active,
 * or bare lane bands when the engine sent lanes but no sign. `null` when
 * there is nothing to draw at all.
 */
function engineModel(point: JunctionDecisionPoint): GantryModel | null {
  const headline = visibleToward(signHeadline(point.sign));
  const exitNumber = point.sign?.exitNumbers?.[0];
  const laneCount = point.laneCount ?? 0;
  if (!headline.length && !exitNumber && laneCount === 0) return null;
  const panels: GantryModel["panels"] =
    headline.length || exitNumber
      ? [
          {
            lanes: point.activeLanes,
            destinations: headline,
            refs: visibleToward(point.sign?.exitBranches ?? []),
            symbols: [],
            isExit: true,
            ...(exitNumber ? { exitNumber } : {}),
          },
        ]
      : [];
  return {
    laneCount,
    panels,
    activeLanes: point.activeLanes,
    source: "engine",
  };
}

/**
 * The junction card: gantry strip on top, photo preview or schematic below.
 * `role="img"` with a lane summary and the toward places — the SVG and photo
 * inside are hidden from assistive tech, and the panel is not live, so an
 * approach never chatters. Nothing here is a touch target while navigating.
 */
export function JunctionViewPanel({ point, gantry, photo, geometry }: Props) {
  const t = useTranslations("navigation");
  const model = gantry ?? engineModel(point);
  if (!model) return null;
  const toward = visibleToward(signHeadline(point.sign));
  const laneSummary =
    model.activeLanes.length === 1
      ? t("junctionLaneSummary", { lane: model.activeLanes[0] + 1, total: model.laneCount })
      : model.activeLanes.length > 1
        ? t("junctionLanesSummary", {
            lanes: model.activeLanes.map((lane) => lane + 1).join(", "),
            total: model.laneCount,
          })
        : model.laneCount > 0
          ? t("junctionLaneCount", { total: model.laneCount })
          : t("junctionViewLabel");
  const branchSummary = model.branches
    ?.flatMap((branch) => {
      const panel = model.panels.find((entry) => entry.branchWayId === branch.wayId);
      const places = [
        ...(branch.refs ?? panel?.refs ?? []),
        ...(branch.destinations ?? panel?.destinations ?? []),
      ].join(", ");
      const count =
        branch.laneCount !== undefined ? t("junctionLaneCount", { total: branch.laneCount }) : "";
      const summary = [places, count].filter(Boolean).join(", ");
      return summary ? [summary] : [];
    })
    .join("; ");
  const label = [
    laneSummary,
    toward.length > 0 ? t("toward", { places: toward.join(", ") }) : null,
    branchSummary ? t("junctionBranchesSummary", { branches: branchSummary }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Box
      role="img"
      aria-label={label}
      sx={{
        bgcolor: "background.paper",
        borderRadius: 3,
        overflow: "hidden",
        p: 1,
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
      data-testid="junction-view-panel"
    >
      {model.panels.length > 0 && <GantryStrip model={model} />}
      {photo?.status === "ready" && photo.image && photo.objectUrl && geometry ? (
        <JunctionPhoto
          image={photo.image}
          objectUrl={photo.objectUrl}
          point={point}
          geometry={geometry}
          exitLanes={{ laneCount: model.laneCount, activeLanes: model.activeLanes }}
        />
      ) : model.laneCount > 0 ? (
        <SchematicBody model={model} point={point} />
      ) : null}
    </Box>
  );
}

function SchematicBody({ model, point }: { model: GantryModel; point: JunctionDecisionPoint }) {
  const t = useTranslations("navigation");
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("junctionViewLabel")}
      </Typography>
      <JunctionSchematicView schematic={buildJunctionSchematic(model, point)} />
    </Box>
  );
}
