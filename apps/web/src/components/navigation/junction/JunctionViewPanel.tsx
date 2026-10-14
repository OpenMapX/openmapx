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
import { JunctionPhoto, JunctionPhotoAttribution } from "./JunctionPhoto";
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
            lanes: point.activeLanes.length
              ? point.activeLanes
              : [point.side === "left" ? 0 : Math.max(laneCount, 1) - 1],
            destinations: headline,
            refs: visibleToward(point.sign?.exitBranches ?? []),
            symbols: [],
            isExit: true,
            ...(exitNumber ? { exitNumber } : {}),
          },
        ]
      : [];
  return {
    laneCount: Math.max(laneCount, 1),
    panels,
    activeLanes: point.activeLanes,
    source: "engine",
  };
}

/**
 * The junction card: gantry strip on top, photo preview or schematic below.
 * `role="img"` with a lane summary and the toward places — the SVG and photo
 * inside are hidden from assistive tech, and the graphic is not live, so an
 * approach never chatters. Captured image credits sit beside the graphic.
 */
export function JunctionViewPanel({ point, gantry, photo, geometry }: Props) {
  const t = useTranslations("navigation");
  const model = gantry ?? engineModel(point);
  if (!model) return null;
  const lane = (model.activeLanes[0] ?? model.laneCount - 1) + 1;
  const toward = visibleToward(signHeadline(point.sign));
  const label = [
    t("junctionLaneSummary", { lane, total: model.laneCount }),
    toward.length > 0 ? t("toward", { places: toward.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  const displayedPhoto =
    photo?.status === "ready" && photo.image && photo.objectUrl && geometry
      ? { image: photo.image, objectUrl: photo.objectUrl, geometry }
      : null;
  const photoKey = displayedPhoto
    ? JSON.stringify([displayedPhoto.image.providerId, displayedPhoto.image.id])
    : undefined;
  return (
    <Box
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
      <Box role="img" aria-label={label} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {model.panels.length > 0 && <GantryStrip model={model} />}
        {displayedPhoto ? (
          <JunctionPhoto
            key={photoKey}
            image={displayedPhoto.image}
            objectUrl={displayedPhoto.objectUrl}
            point={point}
            geometry={displayedPhoto.geometry}
            exitLanes={{ laneCount: model.laneCount, activeLanes: model.activeLanes }}
          />
        ) : (
          <SchematicBody model={model} point={point} />
        )}
      </Box>
      {displayedPhoto && <JunctionPhotoAttribution key={photoKey} image={displayedPhoto.image} />}
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
