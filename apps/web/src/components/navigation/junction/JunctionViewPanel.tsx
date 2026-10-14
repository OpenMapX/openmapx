"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  buildJunctionSchematic,
  type GantryModel,
  type JunctionDecisionPoint,
  type LngLat,
  type StreetLevelImage,
  signHeadline,
  visibleToward,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type Ref, useLayoutEffect, useState } from "react";
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
  /** Whole-card budget measured by the containing navigation chrome; null while pending. */
  availableHeight?: number | null;
  panelRef?: Ref<HTMLDivElement>;
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

const CARD_SX = {
  bgcolor: "background.paper",
  borderRadius: 3,
  overflow: "hidden",
  p: 1,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxSizing: "border-box",
} as const;

type DisplayedPhoto = { image: StreetLevelImage; objectUrl: string; geometry: LngLat[] };

/**
 * The junction card: gantry strip on top, photo preview or schematic below.
 * `role="img"` with a lane summary and the toward places — the SVG and photo
 * inside are hidden from assistive tech, and the graphic is not live, so an
 * approach never chatters. Captured image credits sit beside the graphic.
 */
export function JunctionViewPanel({
  point,
  gantry,
  photo,
  geometry,
  availableHeight,
  panelRef,
}: Props) {
  const t = useTranslations("navigation");
  const model = gantry ?? engineModel(point);
  const candidatePhoto =
    photo?.status === "ready" && photo.image && photo.objectUrl && geometry
      ? { image: photo.image, objectUrl: photo.objectUrl, geometry }
      : null;
  const [measurementEl, setMeasurementEl] = useState<HTMLDivElement | null>(null);
  const [measurement, setMeasurement] = useState<{
    image: StreetLevelImage;
    element: HTMLElement;
    height: number;
  } | null>(null);
  const candidateImage = candidatePhoto?.image;
  useLayoutEffect(() => {
    if (!measurementEl || !candidateImage) return;
    const update = () => {
      const height = measurementEl.getBoundingClientRect().height;
      setMeasurement((previous) =>
        previous?.image === candidateImage &&
        previous.element === measurementEl &&
        previous.height === height
          ? previous
          : { image: candidateImage, element: measurementEl, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(measurementEl);
    return () => observer.disconnect();
  }, [measurementEl, candidateImage]);
  if (!model) return null;
  const lane = (model.activeLanes[0] ?? model.laneCount - 1) + 1;
  const toward = visibleToward(signHeadline(point.sign));
  const label = [
    t("junctionLaneSummary", { lane, total: model.laneCount }),
    toward.length > 0 ? t("toward", { places: toward.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  const photoKey = candidatePhoto
    ? JSON.stringify([candidatePhoto.image.providerId, candidatePhoto.image.id])
    : undefined;
  const fits =
    availableHeight === undefined ||
    (availableHeight !== null &&
      measurement !== null &&
      measurement.image === candidateImage &&
      measurement.element === measurementEl &&
      measurement.height > 0 &&
      measurement.height <= availableHeight);
  return (
    <Box ref={panelRef} sx={{ ...CARD_SX, position: "relative" }} data-testid="junction-view-panel">
      <JunctionBody
        model={model}
        point={point}
        label={label}
        photo={fits ? candidatePhoto : null}
        photoKey={photoKey}
      />
      {availableHeight !== undefined && candidatePhoto && (
        <Box
          key={photoKey}
          ref={setMeasurementEl}
          inert
          aria-hidden="true"
          data-testid="junction-photo-measurement"
          sx={{
            ...CARD_SX,
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            visibility: "hidden",
            pointerEvents: "none",
          }}
        >
          <JunctionBody
            model={model}
            point={point}
            label={label}
            photo={candidatePhoto}
            photoKey={photoKey}
          />
        </Box>
      )}
    </Box>
  );
}

/** Same intrinsic layout for displayed guidance and the always-hidden full-photo candidate. */
function JunctionBody({
  model,
  point,
  label,
  photo,
  photoKey,
}: {
  model: GantryModel;
  point: JunctionDecisionPoint;
  label: string;
  photo: DisplayedPhoto | null;
  photoKey?: string;
}) {
  return (
    <>
      <Box role="img" aria-label={label} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {model.panels.length > 0 && <GantryStrip model={model} />}
        {photo ? (
          <JunctionPhoto
            key={photoKey}
            image={photo.image}
            objectUrl={photo.objectUrl}
            point={point}
            geometry={photo.geometry}
            exitLanes={{ laneCount: model.laneCount, activeLanes: model.activeLanes }}
          />
        ) : (
          <SchematicBody model={model} point={point} />
        )}
      </Box>
      {photo && <JunctionPhotoAttribution key={photoKey} image={photo.image} />}
    </>
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
