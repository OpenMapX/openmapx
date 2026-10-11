"use client";

import Box from "@mui/material/Box";
import {
  cleanSignTexts,
  exitNumberLabel,
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

interface Props {
  point: JunctionDecisionPoint;
  /** The gantry fetched from OSM, when available; otherwise an engine-only model is built. */
  gantry?: GantryModel;
  /** The prefetched photo for this decision point, when one qualified. */
  photo?: JunctionPhotoState;
  country?: string;
  /** The route being driven, for projecting the path ahead onto the photo. */
  geometry?: LngLat[];
}

/**
 * The engine-only gantry, shown until real OSM lane tags arrive: the exit
 * panel drawn from the engine sign over the lanes the engine marked active,
 * or lane metadata for the photo when the engine sent lanes but no sign.
 * An empty model when neither signs nor lanes are known; a photo can still render.
 */
function engineModel(point: JunctionDecisionPoint): GantryModel {
  const headline = visibleToward(signHeadline(point.sign));
  const exitNumber = exitNumberLabel(point.sign?.exitNumbers?.[0]);
  const laneCount = point.laneCount ?? 0;
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
    laneGuidance: point.laneCount ? point.laneGuidance : undefined,
    laneSelectionReliable: false,
    selectedRoute: {
      refs: cleanSignTexts(point.sign?.exitBranches ?? [], true),
      destinations: headline,
      ...(exitNumber ? { exitNumber } : {}),
      turn: point.direction,
    },
    source: "engine",
  };
}

/**
 * The junction card: gantry strip with an optional photo preview below.
 * `role="img"` with a lane summary and the toward places — the signs and photo
 * inside are hidden from assistive tech, and the panel is not live, so an
 * approach never chatters. Nothing here is a touch target while navigating.
 */
export function JunctionViewPanel({ point, gantry, photo, geometry, country }: Props) {
  const t = useTranslations("navigation");
  const model = gantry ?? engineModel(point);
  const readyPhoto =
    photo?.status === "ready" && photo.image && photo.objectUrl && photo.prepared && geometry
      ? { image: photo.image, objectUrl: photo.objectUrl, prepared: photo.prepared, geometry }
      : null;
  const selected = model.selectedRoute ?? {
    refs: point.sign?.exitBranches ?? [],
    destinations: signHeadline(point.sign),
    exitNumber: exitNumberLabel(point.sign?.exitNumbers?.[0]),
  };
  const routeSummary = [
    ...cleanSignTexts(selected.refs, true),
    ...cleanSignTexts(selected.destinations),
    ...(selected.exitNumber ? [t("exitNumber", { number: selected.exitNumber })] : []),
  ].join(", ");
  const showSigns = model.panels.length > 0 || routeSummary.length > 0;
  if (!showSigns && !readyPhoto) return null;
  const guidance = model.laneGuidance;
  const preferred = guidance?.preferredLanes ?? [];
  const usable = guidance?.usableLanes ?? model.activeLanes;
  const indices = (lanes: number[]) => lanes.map((lane) => lane + 1).join(", ");
  const laneSummary = preferred.length
    ? t("junctionPreferredLanes", { lanes: indices(preferred), total: model.laneCount })
    : usable.length
      ? t("junctionUsableLanes", { lanes: indices(usable), total: model.laneCount })
      : model.laneCount > 0
        ? t("junctionLaneGuidanceUnknown")
        : "";
  const credit = readyPhoto
    ? t("junctionPhotoCaption", {
        author: readyPhoto.image.author ?? readyPhoto.image.providerId,
        license: readyPhoto.image.license ?? "",
        date: readyPhoto.image.capturedAt?.slice(0, 7) ?? "",
      })
    : "";
  const label = [routeSummary || t("junctionViewLabel"), laneSummary, credit]
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
      {showSigns && (
        <Box aria-hidden>
          <GantryStrip model={{ ...model, selectedRoute: selected }} country={country} />
        </Box>
      )}
      {readyPhoto && (
        <JunctionPhoto
          image={readyPhoto.image}
          prepared={readyPhoto.prepared}
          objectUrl={readyPhoto.objectUrl}
        />
      )}
    </Box>
  );
}
