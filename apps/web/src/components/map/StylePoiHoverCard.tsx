"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import DirectionsIcon from "@mui/icons-material/Directions";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Rating from "@mui/material/Rating";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { presentOpeningHoursInfo, proxyImageUrl, useOpeningHoursClock } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { BRAND, BRAND_LIGHT } from "@/integration-api/runtime/theme";
import { openingHoursTone } from "@/lib/openingHoursTone";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";
import { HOVER_CARD_WIDTH, type HoverCardPlacement } from "./stylePoiHoverPlacement";

const PHOTO_HEIGHT = 112;
const WHEELCHAIR_OK = new Set(["yes", "limited", "designated"]);

export interface StylePoiHoverCardProps {
  /** The name the map prints beside the icon; shown at once, before details load. */
  name: string;
  /** Details from the place lookup, once they arrive. */
  details?: Place;
  /** Details were requested and have not arrived yet. */
  loading: boolean;
  placement: HoverCardPlacement;
  saved?: boolean;
  onOpen: () => void;
  onDirections: () => void;
  onSave: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

function RoundAction({
  label,
  filled,
  onClick,
  children,
}: {
  label: string;
  filled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip title={label} placement="top">
      <IconButton
        aria-label={label}
        onClick={(event) => {
          // The card itself opens the place; a button does only its own job.
          event.stopPropagation();
          onClick();
        }}
        sx={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          bgcolor: filled ? BRAND : BRAND_LIGHT,
          color: filled ? "#fff" : BRAND,
          "&:hover": { bgcolor: filled ? BRAND : BRAND_LIGHT, filter: "brightness(0.93)" },
          "& svg": { fontSize: 20 },
        }}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Preview of a basemap POI shown while the pointer rests on it: the name at
 * once, then photo, rating, category, wheelchair access and open status as the
 * place lookup returns them. Clicking it opens the place like clicking the POI.
 */
export function StylePoiHoverCard({
  name,
  details,
  loading,
  placement,
  saved = false,
  onOpen,
  onDirections,
  onSave,
  onPointerEnter,
  onPointerLeave,
}: StylePoiHoverCardProps) {
  const t = useTranslations("place");
  const locale = useLocale();
  const hoursText = useOpeningHoursText();
  const now = useOpeningHoursClock();
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);

  const photo = details?.photos?.find((candidate) => /^https?:\/\//.test(candidate.url));
  const showPhoto = photo !== undefined && photo.url !== failedPhoto;
  const hours = presentOpeningHoursInfo(details?.openingHoursInfo, details?.openingHours, now);
  const status = hours?.status;
  const hoursDetail = status ? hoursText.detail(status) : "";
  const wheelchair = details?.osmTags?.wheelchair;
  const category = details?.category?.toLowerCase() === "poi" ? undefined : details?.category;

  return (
    <Paper
      component="section"
      aria-label={name}
      data-testid="poi-hover-card"
      elevation={6}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={onOpen}
      sx={{
        // Viewport coordinates: the card lives outside the map element.
        position: "fixed",
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        width: HOVER_CARD_WIDTH,
        borderRadius: "12px",
        overflow: "hidden",
        cursor: "pointer",
        // Above the map's floating chrome, below dialogs and menus.
        zIndex: 12,
        animation: "omx-poi-hover-in 120ms ease-out",
        "@keyframes omx-poi-hover-in": {
          from: {
            opacity: 0,
            transform: `translateY(${placement.side === "below" ? -4 : 4}px)`,
          },
          to: { opacity: 1, transform: "none" },
        },
        "@media (prefers-reduced-motion: reduce)": { animation: "none" },
      }}
    >
      {showPhoto && (
        <Box
          component="img"
          src={proxyImageUrl(photo.url)}
          alt=""
          onError={() => setFailedPhoto(photo.url)}
          sx={{ display: "block", width: "100%", height: PHOTO_HEIGHT, objectFit: "cover" }}
        />
      )}
      <Box sx={{ px: 2, pt: 1.5, pb: 1.75 }}>
        {/* The name shares its row with the actions; the facts below it get the
            card's full width so an opening time never wraps mid-phrase. */}
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
          <Typography
            sx={{
              flex: 1,
              minWidth: 0,
              pt: 0.75,
              fontWeight: 600,
              fontSize: 16,
              lineHeight: 1.3,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {name}
          </Typography>
          <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
            <RoundAction label={t("directions")} filled onClick={onDirections}>
              <DirectionsIcon />
            </RoundAction>
            <RoundAction label={saved ? t("savedPlace") : t("savePlace")} onClick={onSave}>
              {saved ? <BookmarkIcon /> : <BookmarkBorderIcon />}
            </RoundAction>
          </Box>
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {loading && !details ? (
            <Box data-testid="poi-hover-card-loading" sx={{ mt: 0.5 }}>
              <Skeleton variant="text" width="60%" height={18} />
              <Skeleton variant="text" width="80%" height={18} />
            </Box>
          ) : (
            <>
              {details?.rating ? (
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.25 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {details.rating.toFixed(1)}
                  </Typography>
                  <Rating
                    value={details.rating}
                    precision={0.5}
                    readOnly
                    size="small"
                    sx={{ fontSize: 15, color: "#FBBC04" }}
                  />
                  {details.reviewCount ? (
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      ({details.reviewCount.toLocaleString(locale)})
                    </Typography>
                  ) : null}
                </Box>
              ) : null}
              {(category || (wheelchair && WHEELCHAIR_OK.has(wheelchair))) && (
                <Typography
                  variant="body2"
                  noWrap
                  sx={{ color: "text.secondary", display: "flex", alignItems: "center", gap: 0.5 }}
                >
                  {category && (
                    <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {category}
                    </Box>
                  )}
                  {wheelchair && WHEELCHAIR_OK.has(wheelchair) && (
                    <>
                      {category && <span aria-hidden>·</span>}
                      <AccessibleIcon
                        titleAccess={t("wheelchairAccessible")}
                        sx={{ fontSize: 16, color: "info.main" }}
                      />
                    </>
                  )}
                </Typography>
              )}
              {status && (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  <Box
                    component="span"
                    sx={{
                      color: openingHoursTone(status),
                      fontWeight: status.isUnknown ? 500 : 600,
                    }}
                  >
                    {hoursText.state(status)}
                  </Box>
                  {hoursDetail && ` · ${hoursDetail}`}
                </Typography>
              )}
            </>
          )}
        </Box>
      </Box>
    </Paper>
  );
}
