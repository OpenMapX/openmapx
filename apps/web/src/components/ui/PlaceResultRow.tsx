"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type {
  CategoryCardEnrichmentResponse,
  CategoryPlace,
  DistanceReference,
} from "@openmapx/core";
import {
  brandForPlaceLogo,
  formatMeasurementDistance,
  isDisplayablePhoto,
  proxyImageUrl,
  resultDistanceMetres,
  useSettingsStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import {
  contributorsForRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { placeBrandIdentity } from "@/components/map/CategoryResultMarkers";
import { selectResultAttributes } from "@/components/panels/category/resultAttributes";
import { PhotoAttribution } from "@/components/panels/place/PhotoAttribution";
import { BrandLogo } from "@/components/search/BrandLogo";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ResultItemName, ResultListItem, ResultRowSkeleton } from "@/components/ui/ResultListItem";
import { openingHoursTone } from "@/lib/openingHoursTone";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";

type CardSummary = CategoryCardEnrichmentResponse["results"][number];

export function categoryRatingSourceName(
  rating: NonNullable<CardSummary["rating"]>,
  registry: { findDataSource(id: string): { name: string } | undefined },
) {
  if (rating.contributors !== undefined)
    return (
      rating.contributors.find((receipt) => receipt.sourceId === rating.source)?.name ??
      rating.source
    );
  return registry.findDataSource(rating.source)?.name ?? rating.source;
}

/** Matches the card's exact branches and the capped attribute selector. Photos own their separate strip. */
export function categoryCardContributors(
  place: CategoryPlace,
  summary: CardSummary | undefined,
  distanceReference: DistanceReference | null,
) {
  const fields = [
    ...(place.name ? ["name"] : []),
    ...(place.category ? ["category"] : []),
    ...(place.address ? ["address"] : []),
    ...(resultDistanceMetres(distanceReference, place.coordinates) !== null ? ["coordinates"] : []),
    ...selectResultAttributes(place.osmTags).map(
      (attribute) =>
        `osmTags.${attribute.kind.startsWith("wheelchair_") ? "wheelchair" : attribute.kind}`,
    ),
    ...(place.openingHoursInfo?.status
      ? ["openingHours", "openingHoursInfo"]
      : place.isOpen !== undefined
        ? ["isOpen"]
        : []),
  ];
  return snapshotContributors(
    contributorsForRecordFields(place, fields),
    summary?.rating?.contributors ?? [],
  );
}

export function PlaceResultRow({
  place,
  summary,
  isHovered,
  onSelect,
  onHover,
  onHoverEnd,
  brandLogos,
  distanceReference,
  footer,
  loading = false,
}: {
  place: CategoryPlace;
  summary?: CardSummary;
  isHovered?: boolean;
  onSelect: (place: CategoryPlace) => void;
  onHover?: (id: string) => void;
  onHoverEnd?: () => void;
  /** QID -> Commons logo filename, resolved once for the whole result list. */
  brandLogos?: Map<string, import("@openmapx/core").BrandDetail | undefined>;
  distanceReference: DistanceReference | null;
  footer?: ReactNode;
  loading?: boolean;
}) {
  const tp = useTranslations("place");
  const locale = useLocale();
  const registry = useIntegrationRegistry();
  const tc = useTranslations("common");
  const tcat = useTranslations("category");
  const units = useSettingsStore((s) => s.units);
  const ohText = useOpeningHoursText();
  const distanceMetres = resultDistanceMetres(distanceReference, place.coordinates);
  const attributes = selectResultAttributes(place.osmTags);
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;
  const brandIdentity = placeBrandIdentity(place);
  const photo = summary?.photo && isDisplayablePhoto(summary.photo) ? summary.photo : undefined;
  const photoUrl = photo?.thumbnailUrl ?? photo?.url;
  const [failedPhotoUrl, setFailedPhotoUrl] = useState<string | null>(null);
  const showPhoto = Boolean(photoUrl && failedPhotoUrl !== photoUrl);
  const rating = summary?.rating;

  const renderCard = (mark?: ReactNode, credits?: ReactNode) => (
    <>
      <ResultListItem
        onClick={() => onSelect(place)}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") onHover?.(place.id);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") onHoverEnd?.();
        }}
        selected={isHovered}
        hoverBg="rgba(0,0,0,0.06)"
        bottomPadding={showPhoto ? 0.25 : undefined}
      >
        {loading ? (
          <ResultRowSkeleton />
        ) : (
          <>
            {showPhoto && photoUrl && (
              <Box
                component="img"
                src={proxyImageUrl(photoUrl)}
                alt=""
                loading="lazy"
                onError={() => setFailedPhotoUrl(photoUrl)}
                sx={{
                  width: 72,
                  height: 72,
                  objectFit: "cover",
                  borderRadius: 1,
                  float: "right",
                  ml: 1,
                  mb: 0.5,
                }}
              />
            )}
            {mark ?? <ResultItemName>{place.name}</ResultItemName>}
            <Box
              sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}
            >
              {tagLabel && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {tagLabel}
                </Typography>
              )}
              {tagLabel && place.address && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  ·
                </Typography>
              )}
              {place.address && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    overflowWrap: "anywhere",
                  }}
                >
                  {place.address}
                </Typography>
              )}
            </Box>
            {rating && (
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mb: 0.25 }}
              >
                ★ {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rating.stars)}{" "}
                · {rating.count} {tp("ratedReviews")} · {categoryRatingSourceName(rating, registry)}
              </Typography>
            )}
            {(distanceMetres !== null || attributes.length > 0) && (
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 0.75,
                  alignItems: "center",
                  minWidth: 0,
                  mb: 0.25,
                }}
              >
                {distanceMetres !== null && (
                  <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
                    {formatMeasurementDistance(distanceMetres, units)}
                  </Typography>
                )}
                {attributes.map((attribute) => (
                  <Typography
                    key={attribute.kind}
                    variant="caption"
                    sx={{ color: "text.secondary", overflowWrap: "anywhere" }}
                  >
                    {attribute.kind === "cuisine"
                      ? `${tcat("cuisine")}: ${attribute.value}`
                      : attribute.kind === "outdoor_seating"
                        ? tp("outdoorSeating")
                        : attribute.kind === "wheelchair_yes"
                          ? tp("wheelchairYes")
                          : attribute.kind === "wheelchair_designated"
                            ? tp("wheelchairDesignated")
                            : tp("wheelchairLimited")}
                  </Typography>
                ))}
              </Box>
            )}
            {(() => {
              const hours = place.openingHoursInfo?.status ?? null;
              if (hours) {
                if (hours.isUnknown) {
                  return (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {ohText.state(hours)}
                    </Typography>
                  );
                }
                const detail = ohText.detail(hours);
                return (
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    <Box component="span" sx={{ color: openingHoursTone(hours), fontWeight: 700 }}>
                      {ohText.state(hours)}
                    </Box>
                    {detail && <> · {detail}</>}
                  </Typography>
                );
              }
              if (place.isOpen !== undefined) {
                return (
                  <Typography
                    variant="body2"
                    sx={{ color: place.isOpen ? "success.main" : "error.main", fontWeight: 700 }}
                  >
                    {place.isOpen ? tc("open") : tc("closed")}
                  </Typography>
                );
              }
              return null;
            })()}
          </>
        )}
      </ResultListItem>
      <Box sx={{ px: 2 }}>
        <AttributionStrip
          attributions={categoryCardContributors(place, summary, distanceReference)}
          variant="inline"
        />
      </Box>
      {credits && (
        <Box sx={{ px: 2, pb: 0.75, color: "text.secondary", fontSize: "0.65rem" }}>{credits}</Box>
      )}
      {showPhoto && photo && (
        <Box sx={{ px: 2, pb: 0.75, color: "text.secondary", fontSize: "0.65rem" }}>
          <PhotoAttribution photo={photo} color="currentColor" />
        </Box>
      )}
      {footer && <Box sx={{ px: 2, pb: 0.75 }}>{footer}</Box>}
    </>
  );
  return brandIdentity ? (
    <BrandLogo
      brand={brandForPlaceLogo(
        place,
        brandLogos?.get(brandIdentity.qid),
        brandIdentity.qid,
        brandIdentity.kind,
      )}
      size={20}
      render={({ mark, credits }) => renderCard(mark, credits)}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <ResultItemName>{place.name}</ResultItemName>
      </Box>
    </BrandLogo>
  ) : (
    renderCard()
  );
}
