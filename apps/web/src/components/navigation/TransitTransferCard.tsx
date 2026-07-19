"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import TransferWithinAStationIcon from "@mui/icons-material/TransferWithinAStation";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { useTransferInfo } from "@/lib/navigation/useTransferInfo";

/**
 * "Change here" card shown beneath the leg banner as the rider approaches the
 * end of a transit leg that is followed by another ride. Amber (vs the red
 * final-alight card) so a transfer reads distinctly from arriving. Names the
 * change stop, the line to board next (with its destination sign) and the
 * boarding platform — flagged if it changed from the scheduled track.
 */
export function TransitTransferCard({
  fromLeg,
  nextLeg,
  walkSeconds,
}: {
  fromLeg: TripLeg;
  nextLeg: TripLeg;
  walkSeconds: number;
}) {
  const t = useTranslations("navigation");
  const { nextHeadsign, boardPlatform, platformChanged, levelChange, stepFree, walkMinutes } =
    useTransferInfo(fromLeg, nextLeg, walkSeconds);

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        pointerEvents: "auto",
        display: "flex",
        gap: 1.5,
        px: 2,
        py: 1.25,
        bgcolor: "warning.main",
        color: "warning.contrastText",
        borderRadius: 2,
        boxShadow: 2,
      }}
    >
      <TransferWithinAStationIcon sx={{ fontSize: 28, flexShrink: 0 }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
          {t("changeAt", { stop: fromLeg.to.name })}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.5, flexWrap: "wrap" }}>
          {nextLeg.route && (
            <RouteBadge
              shortName={nextLeg.route.shortName}
              color={nextLeg.route.color}
              textColor={nextLeg.route.textColor}
              mode={nextLeg.mode}
            />
          )}
          {nextHeadsign && (
            <Typography variant="caption" sx={{ opacity: 0.95 }} noWrap>
              {t("towards", { headsign: nextHeadsign })}
            </Typography>
          )}
          {boardPlatform && (
            <PlatformBadge code={boardPlatform} tone="onBanner" changed={platformChanged} />
          )}
        </Box>
        {walkMinutes > 0 && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
            <DirectionsWalkIcon sx={{ fontSize: 15 }} />
            <Typography variant="caption">{t("transferWalk", { minutes: walkMinutes })}</Typography>
          </Box>
        )}
        {levelChange && (
          <Typography variant="caption" sx={{ display: "block", mt: 0.25 }}>
            {t("levelChange", { from: levelChange.from, to: levelChange.to })}
          </Typography>
        )}
        {stepFree && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
            <AccessibleIcon sx={{ fontSize: 15 }} />
            <Typography variant="caption">
              {t(stepFree.wheelchairUsesElevator ? "stepFreeElevator" : "stepFree", {
                minutes: Math.max(1, Math.round(stepFree.wheelchairMinutes ?? 0)),
              })}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
