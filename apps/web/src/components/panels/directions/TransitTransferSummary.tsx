"use client";

import TransferWithinAStationIcon from "@mui/icons-material/TransferWithinAStation";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { useTransferInfo } from "@/lib/navigation/useTransferInfo";

/**
 * Inline interchange summary in the planning itinerary timeline: a calm "change
 * here" marker (vs the nav amber card) at a transfer between two rides. Shares
 * {@link useTransferInfo} with the nav {@link TransitTransferCard} so both show
 * the same facts — next line + destination, boarding platform (flagged on
 * change), step-free option, level change, and the transfer walk.
 */
export function TransitTransferSummary({
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

  const extras = [
    walkMinutes > 0 ? t("transferWalk", { minutes: walkMinutes }) : null,
    levelChange ? t("levelChange", { from: levelChange.from, to: levelChange.to }) : null,
    stepFree
      ? t(stepFree.wheelchairUsesElevator ? "stepFreeElevator" : "stepFree", {
          minutes: Math.max(1, Math.round(stepFree.wheelchairMinutes ?? 0)),
        })
      : null,
  ].filter(Boolean);

  return (
    <Box
      sx={{
        ml: 9,
        my: 0.5,
        px: 1,
        py: 0.75,
        borderRadius: 2,
        bgcolor: "action.hover",
        display: "flex",
        gap: 1,
      }}
    >
      <TransferWithinAStationIcon sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0 }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="caption" sx={{ fontWeight: 600, display: "block" }}>
          {t("changeAt", { stop: fromLeg.to.name })}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.25, flexWrap: "wrap" }}>
          {nextLeg.route && (
            <RouteBadge
              shortName={nextLeg.route.shortName}
              color={nextLeg.route.color}
              textColor={nextLeg.route.textColor}
              mode={nextLeg.mode}
              size="small"
            />
          )}
          {nextHeadsign && (
            <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
              {t("towards", { headsign: nextHeadsign })}
            </Typography>
          )}
          {boardPlatform && <PlatformBadge code={boardPlatform} changed={platformChanged} />}
        </Box>
        {extras.length > 0 && (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
          >
            {extras.join(" · ")}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
