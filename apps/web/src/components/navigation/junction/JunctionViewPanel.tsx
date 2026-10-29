"use client";

import Box from "@mui/material/Box";
import {
  cleanSignTexts,
  exitNumberLabel,
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
import type { PreparedJunctionPhoto } from "@/lib/navigation/prepareJunctionPhoto";
import { GantryStrip } from "./GantryStrip";
import { JunctionPhoto, JunctionPhotoAttribution } from "./JunctionPhoto";

interface Props {
  point: JunctionDecisionPoint;
  /** The gantry fetched from OSM, when available; otherwise an engine-only model is built. */
  gantry?: GantryModel;
  /** The prefetched photo for this decision point, when one qualified. */
  photo?: JunctionPhotoState;
  country?: string;
  /** The route being driven, for projecting the path ahead onto the photo. */
  geometry?: LngLat[];
  availableHeight?: number | null;
  panelRef?: Ref<HTMLDivElement>;
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
 * approach never chatters. Captured image credits sit outside the graphic.
 */
export function JunctionViewPanel({
  point,
  gantry,
  photo,
  geometry,
  country,
  availableHeight,
  panelRef,
}: Props) {
  const t = useTranslations("navigation");
  const model = gantry ?? engineModel(point);
  const candidatePhoto =
    photo?.status === "ready" && photo.image && photo.objectUrl && photo.prepared && geometry
      ? { image: photo.image, objectUrl: photo.objectUrl, prepared: photo.prepared, geometry }
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
  const label = [routeSummary || t("junctionViewLabel"), laneSummary].filter(Boolean).join(", ");
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
  if (!showSigns && !candidatePhoto) return null;
  const renderBody = (displayed: typeof candidatePhoto) => (
    <JunctionBody
      model={{ ...model, selectedRoute: selected }}
      country={country}
      showSigns={showSigns}
      label={label}
      photo={displayed}
      photoKey={photoKey}
    />
  );
  return (
    <Box ref={panelRef} sx={{ ...CARD_SX, position: "relative" }} data-testid="junction-view-panel">
      {renderBody(fits ? candidatePhoto : null)}
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
          {renderBody(candidatePhoto)}
        </Box>
      )}
    </Box>
  );
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

function JunctionBody({
  model,
  country,
  showSigns,
  label,
  photo,
  photoKey,
}: {
  model: GantryModel;
  country?: string;
  showSigns: boolean;
  label: string;
  photo: { image: StreetLevelImage; objectUrl: string; prepared: PreparedJunctionPhoto } | null;
  photoKey?: string;
}) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const photoIdentity = photo ? JSON.stringify([photoKey, photo.objectUrl]) : null;
  const displayedPhoto = photoIdentity !== failedPhoto ? photo : null;
  return (
    <>
      <Box role="img" aria-label={label} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {showSigns && (
          <Box aria-hidden>
            <GantryStrip model={model} country={country} />
          </Box>
        )}
        {displayedPhoto && (
          <JunctionPhoto
            key={photoIdentity ?? undefined}
            image={displayedPhoto.image}
            objectUrl={displayedPhoto.objectUrl}
            prepared={displayedPhoto.prepared}
            onPhotoError={() => setFailedPhoto(photoIdentity)}
          />
        )}
      </Box>
      {displayedPhoto && (
        <JunctionPhotoAttribution key={photoIdentity ?? undefined} image={displayedPhoto.image} />
      )}
    </>
  );
}
