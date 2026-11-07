"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NotificationImportantIcon from "@mui/icons-material/NotificationImportant";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { type TransitProgress, useNavigationStore, useVehicleJourney } from "@openmapx/core";
import type { TransitTransfer } from "@openmapx/core/navigation";
import { isApproachingTransitAlight, selectLegPlatform } from "@openmapx/core/navigation";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { OccupancyIndicator } from "@/components/panels/transit/OccupancyIndicator";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import {
  TransitDataStatus,
  TransitQueryNotice,
} from "@/components/panels/transit/TransitDataStatus";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useNow } from "@/lib/useNow";
import { NavBannerShell } from "./NavBannerShell";
import { TransitTransferCard } from "./TransitTransferCard";

/**
 * Glanceable instruction for the selected ride, with an emphasized alight or
 * transfer prompt below. Walking keeps the shared primary maneuver treatment.
 */
export function TransitLegBanner({
  leg,
  legIndex,
  transitProgress,
  transfer,
  source,
  presentation = "map",
}: {
  source?: string;
  presentation?: "map" | "sheet";
  leg: TripLeg;
  legIndex: number;
  transitProgress: TransitProgress | null;
  /** The upcoming change onto another line, when this ride is not the last. */
  transfer?: TransitTransfer | null;
}) {
  const t = useTranslations("navigation");
  const tt = useTranslations("transit");
  const now = useNow(30_000);
  const isTransitLeg = leg.mode !== "walking" && !!leg.route;
  // The shell captured this leg's stops before the trip started and keeps them
  // in the session. Querying again would be a second live-data owner, and the
  // one that stops working underground.
  const { browserAuthority } = useMobileRuntime();
  const journeyQuery = useVehicleJourney(
    browserAuthority && isTransitLeg ? (leg.tripId ?? null) : null,
  );
  const { data: journey } = journeyQuery;

  const captures = useNavigationStore((s) => s.transitCaptures);
  const capture = captures.find(
    (c) => c.legIndex === legIndex && c.tripId === leg.tripId && c.status === "captured",
  );
  const legStops = capture?.stops ?? [];
  const cursor = transitProgress?.stopCursor ?? 1;
  const nextStopName = legStops[cursor]?.name ?? null;
  const stopsRemaining = Math.max(0, legStops.length - cursor);

  // Boarding platform is only relevant until you're on board; once under way the
  // alight platform (surfaced on the "get off" card) is what matters.
  const departed = transitProgress?.phase === "riding";
  // Only aboard can the next stop be the one to get off at; waiting at the
  // boarding stop, a fix just past its pole must not sound the get-off alarm.
  const alightSoon =
    departed &&
    transitProgress?.confidence === "gps" &&
    !leg.cancelled &&
    isApproachingTransitAlight(legStops, cursor, transitProgress.position);
  const boarding = selectLegPlatform(leg, legIndex, captures, "departure");
  const alighting = selectLegPlatform(leg, legIndex, captures, "arrival");
  const boardingPlatform = boarding.code;
  const alightPlatform = alighting.code;
  // Show the vehicle's destination sign when it adds information beyond the
  // alight stop already named in the title.
  const headsign = leg.headsign && leg.headsign !== leg.to.name ? leg.headsign : undefined;
  // Prefer the live vehicle's crowding, falling back to the planned leg value.
  const occupancy = journey?.occupancy ?? leg.occupancy;
  // Bus-stop signage code, shown while boarding when there's no platform.
  const boardingStopCode = leg.from.stopCode;
  // OSM floor of the board/alight platform (0 = ground, hidden as implicit).
  const boardingLevel = leg.from.level != null && leg.from.level !== 0 ? leg.from.level : null;
  const alightLevel = leg.to.level != null && leg.to.level !== 0 ? leg.to.level : null;

  const leading =
    leg.mode === "walking" || !leg.route ? (
      <DirectionsWalkIcon sx={{ fontSize: 40 }} />
    ) : (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        textColor={leg.route.textColor}
        mode={leg.mode}
        size="medium"
      />
    );

  const title =
    leg.mode === "walking"
      ? t("walkTo", { place: leg.to.name })
      : leg.cancelled
        ? `${leg.route?.shortName ?? leg.route?.longName ?? ""} · ${tt("canceled")}`
        : departed && nextStopName
          ? nextStopName
          : !departed && isTransitLeg
            ? (leg.headsign ?? leg.to.name)
            : t("ride", {
                line: leg.route?.shortName ?? leg.route?.longName ?? "",
                to: !departed ? (leg.headsign ?? leg.to.name) : leg.to.name,
              });

  // Sub-row: the live next-stop / alight preview for transit legs. Hidden while
  // `alightSoon`, since the prominent card below carries that message instead.
  const secondary =
    isTransitLeg && !leg.cancelled && !alightSoon ? (
      <Typography variant="body2" sx={{ lineHeight: 1.45 }}>
        {departed && nextStopName
          ? t("stopsRemaining", { count: stopsRemaining })
          : !departed && legStops.length > 1
            ? // Still at the boarding stop: the whole ride lies ahead.
              t("alightAtCount", { place: leg.to.name, count: legStops.length - 1 })
            : stopsRemaining > 0
              ? t("alightAtCount", { place: leg.to.name, count: stopsRemaining })
              : t("stopCountUnavailable")}
      </Typography>
    ) : undefined;

  const heading = (
    <Box sx={{ minWidth: 0, flex: 1 }}>
      {isTransitLeg && !departed && !leg.cancelled && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.25 }}>
          {t("boardLabel")}
        </Typography>
      )}
      {departed && nextStopName && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.25 }}>
          {t(transitProgress?.confidence === "gps" ? "nextStopLabel" : "lastKnownNextStopLabel")}
        </Typography>
      )}
      <Typography
        variant="h6"
        role="status"
        aria-live="polite"
        sx={{
          fontSize: presentation === "sheet" ? "1.125rem" : undefined,
          lineHeight: 1.3,
          fontWeight: 600,
          overflowWrap: "anywhere",
        }}
      >
        {title}
      </Typography>
      {isTransitLeg && (
        <TransitDataStatus
          now={now}
          realtime={leg.realtime}
          freshness={journeyQuery.freshness}
          source={source}
          queryFailed={journeyQuery.isError}
        />
      )}
      {isTransitLeg &&
        (((departed || leg.cancelled) && headsign) ||
          (!departed && (boardingPlatform || boardingStopCode || boardingLevel != null))) && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 0.75,
              mt: 0.25,
              minWidth: 0,
            }}
          >
            {(departed || leg.cancelled) && headsign && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: "anywhere" }}
              >
                {t("towards", { headsign })}
              </Typography>
            )}
            {!departed && boardingPlatform ? (
              <PlatformBadge
                code={boardingPlatform}
                tone="surface"
                changed={boarding.changed}
                scheduledCode={boarding.scheduledCode}
              />
            ) : !departed && boardingStopCode ? (
              <Typography variant="caption" color="text.secondary">
                {t("stopCode", { code: boardingStopCode })}
              </Typography>
            ) : null}
            {!departed && boardingLevel != null && (
              <Typography variant="caption" color="text.secondary">
                {t("levelShort", { level: boardingLevel })}
              </Typography>
            )}
          </Box>
        )}
    </Box>
  );
  const trailing =
    isTransitLeg && (occupancy || leg.bikesAllowed || leg.wheelchairAccessible) ? (
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
        {occupancy && <OccupancyIndicator level={occupancy} size={24} />}
        {leg.bikesAllowed && (
          <Tooltip title={t("bikesAllowed")} placement="left" arrow>
            <DirectionsBikeIcon aria-label={t("bikesAllowed")} sx={{ fontSize: 20 }} />
          </Tooltip>
        )}
        {leg.wheelchairAccessible && (
          <Tooltip title={t("wheelchairAccessible")} placement="left" arrow>
            <AccessibleIcon aria-label={t("wheelchairAccessible")} sx={{ fontSize: 20 }} />
          </Tooltip>
        )}
      </Box>
    ) : undefined;
  const showInstruction = presentation === "map" || departed || leg.cancelled || !isTransitLeg;
  return (
    <>
      {showInstruction &&
        (presentation === "sheet" ? (
          <Box sx={{ px: 2, pt: 1.5, pb: 1, display: "flex", alignItems: "center", gap: 1.5 }}>
            {leading}
            {heading}
            {trailing}
          </Box>
        ) : (
          <NavBannerShell
            tone={isTransitLeg ? "surface" : "primary"}
            leading={leading}
            secondary={secondary}
            trailing={trailing}
          >
            {heading}
          </NavBannerShell>
        ))}
      {presentation === "sheet" && isTransitLeg && departed && !leg.cancelled && !alightSoon && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1.5 }}>
          {t("alightAtCount", { place: leg.to.name, count: stopsRemaining })}
        </Typography>
      )}
      {!showInstruction && trailing && (
        <Box sx={{ px: 2, pt: 1, display: "flex", justifyContent: "flex-end" }}>{trailing}</Box>
      )}
      {!showInstruction && leg.realtime !== false && (
        <Box sx={{ px: 2, pt: 1, "&:empty": { display: "none" } }}>
          <TransitDataStatus
            now={now}
            realtime={leg.realtime}
            freshness={journeyQuery.freshness}
            source={source}
            queryFailed={journeyQuery.isError}
          />
        </Box>
      )}
      {isTransitLeg && (
        <TransitQueryNotice
          onMap={presentation === "map"}
          failed={journeyQuery.isError}
          partial={journeyQuery.freshness?.isPartial}
          onRetry={
            browserAuthority
              ? () => {
                  void journeyQuery.refetch();
                }
              : undefined
          }
          retrying={journeyQuery.isFetching}
        />
      )}
      {alightSoon && transfer && !transfer.nextLeg.cancelled ? (
        <TransitTransferCard
          fromLeg={leg}
          nextLeg={transfer.nextLeg}
          walkSeconds={transfer.walkSeconds}
          inline={presentation === "sheet"}
        />
      ) : alightSoon ? (
        <Box
          role="status"
          aria-live="polite"
          sx={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            px: 2,
            py: 1.25,
            bgcolor: "background.paper",
            color: "text.primary",
            ...(presentation === "sheet"
              ? {
                  borderTop: "1px solid",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  bgcolor: "action.hover",
                }
              : { borderRadius: "28px", boxShadow: 1 }),
          }}
        >
          <Box
            sx={{
              display: "grid",
              placeItems: "center",
              width: presentation === "sheet" ? 24 : 44,
              height: presentation === "sheet" ? 24 : 44,
              flexShrink: 0,
              borderRadius: "50%",
              bgcolor: presentation === "sheet" ? "transparent" : "primary.main",
              color: presentation === "sheet" ? "primary.main" : "primary.contrastText",
            }}
          >
            <NotificationImportantIcon />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("alightSoon")}
            </Typography>
            {transfer?.nextLeg.cancelled && (
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {tt("nextServiceCanceled")}
                {transfer.nextLeg.route?.shortName ? ` · ${transfer.nextLeg.route.shortName}` : ""}
              </Typography>
            )}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
              <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                {t("alightAt", { place: leg.to.name })}
              </Typography>
              {alightPlatform && (
                <PlatformBadge
                  code={alightPlatform}
                  scheduledCode={alighting.scheduledCode}
                  tone="surface"
                />
              )}
              {alightLevel != null && (
                <Typography variant="caption" noWrap>
                  {t("levelShort", { level: alightLevel })}
                </Typography>
              )}
            </Box>
          </Box>
        </Box>
      ) : null}
    </>
  );
}
