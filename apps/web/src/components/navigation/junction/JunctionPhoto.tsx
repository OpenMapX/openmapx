"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { PhotoRoutePath, StreetLevelImage } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import type { PreparedJunctionPhoto } from "@/lib/navigation/prepareJunctionPhoto";

const PHOTO_HEIGHT = 180;
/** Equirectangular frames cover the whole sphere, always 2:1. */
const PANO_VIEWBOX = { width: 360, height: 180 };

/**
 * The photo preview: the image with the route ahead projected onto it, and a
 * separate capture month. Everything decorative is `aria-hidden`; the panel
 * owns the accessible graphic and renders captured credits beside it.
 */
export function JunctionPhoto({
  image,
  objectUrl,
  prepared,
  onPhotoError,
}: {
  image: StreetLevelImage;
  objectUrl: string;
  prepared: PreparedJunctionPhoto;
  onPhotoError?: () => void;
}) {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const { path, aspectRatio } = prepared;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const onError = () => {
    setFailedUrl(objectUrl);
    onPhotoError?.();
  };
  if (failedUrl === objectUrl) return null;
  const capturedAt = image.capturedAt ? new Date(image.capturedAt) : null;
  const date =
    capturedAt && Number.isFinite(capturedAt.getTime())
      ? new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(capturedAt)
      : "";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }} data-testid="junction-photo">
      {image.isPano && path.crop ? (
        <PanoramaWindow image={image} objectUrl={objectUrl} path={path} onError={onError} />
      ) : (
        <Box sx={{ height: PHOTO_HEIGHT, position: "relative", overflow: "hidden" }}>
          <Box
            component="img"
            aria-hidden
            alt=""
            src={objectUrl}
            onError={onError}
            sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {path.visible && (
            <RoutePathOverlay
              path={path}
              viewBox={{ width: 100, height: 100 / aspectRatio }}
              sx={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
            />
          )}
        </Box>
      )}
      {date && (
        <Typography data-capture-month variant="caption" sx={{ color: "text.secondary" }}>
          {t("junctionPhotoDate", { date })}
        </Typography>
      )}
    </Box>
  );
}

/** Captured image receipts only; empty receipts never borrow legacy provider fields. */
export function JunctionPhotoAttribution({ image }: { image: StreetLevelImage }) {
  return (
    <AttributionStrip
      attributions={[...(image.contributors ?? [])]}
      variant="plain"
      surface="image"
      provenanceDisplay="details"
    />
  );
}

/**
 * A 90° slice of an equirectangular panorama. The image's horizontal centre
 * faces `image.heading`, so its left edge is `heading − 180`; the crop window
 * starts `startDeg` clockwise from north. The image is laid out four windows
 * wide (360° / 90°) and slid left by the window's offset from that edge. A
 * window that wraps past the right edge is completed by a second copy. The
 * path overlay is laid out over the same strip, so it slides with the image.
 */
function PanoramaWindow({
  image,
  objectUrl,
  path,
  onError,
}: {
  image: StreetLevelImage;
  objectUrl: string;
  path: PhotoRoutePath;
  onError: () => void;
}) {
  const crop = path.crop ?? { startDeg: 0, spanDeg: 90 };
  const leftEdgeDeg = (path.imageHeadingDeg ?? image.heading ?? 0) - 180;
  const offsetDeg = (((crop.startDeg - leftEdgeDeg) % 360) + 360) % 360;
  const windowsPerTurn = 360 / crop.spanDeg;
  const leftPercent = -(offsetDeg / crop.spanDeg) * 100;
  const wraps = offsetDeg + crop.spanDeg > 360;
  const slice = {
    position: "absolute" as const,
    top: 0,
    width: `${windowsPerTurn * 100}%`,
    maxWidth: "none",
    height: "100%",
    objectFit: "cover" as const,
  };
  return (
    <Box
      sx={{ overflow: "hidden", height: PHOTO_HEIGHT, position: "relative" }}
      data-pano
      data-crop-start={crop.startDeg}
      data-crop-span={crop.spanDeg}
    >
      <Box
        component="img"
        aria-hidden
        alt=""
        src={objectUrl}
        data-left-percent={leftPercent}
        onError={onError}
        sx={{ ...slice, left: `${leftPercent}%` }}
      />
      {wraps && (
        <Box
          component="img"
          aria-hidden
          alt=""
          src={objectUrl}
          data-left-percent={leftPercent + windowsPerTurn * 100}
          onError={onError}
          sx={{ ...slice, left: `${leftPercent + windowsPerTurn * 100}%` }}
        />
      )}
      {path.visible &&
        [leftPercent, ...(wraps ? [leftPercent + windowsPerTurn * 100] : [])].map((left) => (
          <RoutePathOverlay
            key={left}
            path={path}
            viewBox={PANO_VIEWBOX}
            sx={{ ...slice, overflow: "visible", left: `${left}%` }}
          />
        ))}
    </Box>
  );
}

/**
 * One fixed ribbon per permitted lane, over the road stretch verified against
 * the photo. Source-image coordinates and crop are shared with the image;
 * separately projected edges preserve the width under camera skew.
 */
function RoutePathOverlay({
  path,
  viewBox,
  sx,
}: {
  path: PhotoRoutePath;
  viewBox: { width: number; height: number };
  sx: SxProps<Theme>;
}) {
  const gradientId = useId();
  const toViewBox = (xPercent: number, yPercent: number): [number, number] => [
    (xPercent / 100) * viewBox.width,
    (yPercent / 100) * viewBox.height,
  ];
  const ribbons = (path.ribbons ?? [path.points]).map((points) => {
    const left = points.map((p) =>
      toViewBox(
        p.left?.xPercent ?? p.xPercent - p.widthPercent / 2,
        p.left?.yPercent ?? p.yPercent,
      ),
    );
    const right = points.map((p) =>
      toViewBox(
        p.right?.xPercent ?? p.xPercent + p.widthPercent / 2,
        p.right?.yPercent ?? p.yPercent,
      ),
    );
    return [...left, ...right.reverse()]
      .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
  });
  const centre = path.points
    .map((p) => `${p.xPercent.toFixed(2)},${p.yPercent.toFixed(2)}`)
    .join(" ");
  return (
    <Box
      component="svg"
      aria-hidden
      viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid slice"
      data-photo-path={centre}
      data-path-head-deg={path.headRotateDeg.toFixed(1)}
      data-lane-shift={path.laneShiftMeters.toFixed(1)}
      sx={{ pointerEvents: "none", ...sx }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="rgba(26, 115, 232, 0.6)" />
          <stop offset="1" stopColor="rgba(26, 115, 232, 0.08)" />
        </linearGradient>
      </defs>
      {ribbons.map((ribbon) => (
        <polygon
          key={ribbon}
          points={ribbon}
          fill={`url(#${gradientId})`}
          stroke="rgba(255, 255, 255, 0.45)"
          strokeWidth={(0.0015 * viewBox.width).toFixed(3)}
          strokeLinejoin="round"
        />
      ))}
    </Box>
  );
}
