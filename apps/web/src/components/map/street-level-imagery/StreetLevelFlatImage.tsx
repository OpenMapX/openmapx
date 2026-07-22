"use client";

import NavigationIcon from "@mui/icons-material/Navigation";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import type { StreetLevelArrow, StreetLevelImage } from "@openmapx/core";
import { useTranslations } from "next-intl";

/** Half the horizontal span, in degrees, across which arrows stay visible. */
const VISIBLE_HALF_ANGLE = 70;

/**
 * Where an arrow sits horizontally, as a percentage of the frame width.
 * Arrows more than VISIBLE_HALF_ANGLE off-centre are behind the viewer.
 */
export function arrowScreenOffset(
  arrow: Pick<StreetLevelArrow, "bearing">,
  viewYawDeg: number,
): { xPercent: number; visible: boolean } {
  let relative = arrow.bearing - viewYawDeg;
  while (relative > 180) relative -= 360;
  while (relative < -180) relative += 360;

  return {
    xPercent: 50 + (relative / VISIBLE_HALF_ANGLE) * 50,
    visible: Math.abs(relative) <= VISIBLE_HALF_ANGLE,
  };
}

/**
 * Renderer for flat (non-360) imagery. Photo Sphere Viewer expects spherical
 * input, so limited-field-of-view photos get a plain frame plus DOM arrows
 * positioned by the same bearing maths the sphere viewer uses. This keeps the
 * navigation model identical across providers and projections.
 */
export function StreetLevelFlatImage({
  image,
  arrows,
  onNavigate,
}: {
  image: StreetLevelImage;
  arrows: StreetLevelArrow[];
  onNavigate: (arrow: StreetLevelArrow) => void;
}) {
  const t = useTranslations("streetLevel");
  const src = image.assets.hd ?? image.assets.sd ?? image.assets.thumb ?? "";
  const viewYaw = image.heading ?? 0;

  return (
    <Box sx={{ position: "absolute", inset: 0, bgcolor: "#000" }}>
      <Box
        component="img"
        src={src}
        alt=""
        sx={{ width: "100%", height: "100%", objectFit: "contain" }}
      />

      {arrows.map((arrow) => {
        const { xPercent, visible } = arrowScreenOffset(arrow, viewYaw);
        if (!visible) return null;

        return (
          <IconButton
            key={`${arrow.providerId}:${arrow.id}`}
            onClick={() => onNavigate(arrow)}
            aria-label={t("moveToNearbyImage")}
            sx={{
              position: "absolute",
              left: `${xPercent}%`,
              bottom: 48,
              transform: "translateX(-50%)",
              bgcolor: "rgba(255,255,255,0.85)",
              color: "#222",
              "&:hover": { bgcolor: "#fff" },
            }}
          >
            <NavigationIcon sx={{ transform: `rotate(${arrow.bearing - viewYaw}deg)` }} />
          </IconButton>
        );
      })}
    </Box>
  );
}
