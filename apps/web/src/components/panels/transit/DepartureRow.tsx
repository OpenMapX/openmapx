"use client";

import AirlineSeatReclineNormalIcon from "@mui/icons-material/AirlineSeatReclineNormal";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Departure, TripRemark } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { formatTime } from "@/lib/formatTime";
import { OCCUPANCY_COLOR, OCCUPANCY_KEY } from "@/lib/transitOccupancy";
import { REMARK_PRIORITY, RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";

interface DepartureRowProps {
  departure: Departure;
  showPlatform?: boolean;
  onClick?: (dep: Departure) => void;
  /** Show a warning indicator when the route has an active severe/critical alert. */
  hasAlert?: boolean;
}

function topRemark(remarks: TripRemark[]): TripRemark {
  return [...remarks].sort((a, b) => REMARK_PRIORITY[b.type] - REMARK_PRIORITY[a.type])[0];
}

export function DepartureRow({
  departure,
  showPlatform = true,
  onClick,
  hasAlert = false,
}: DepartureRowProps) {
  const t = useTranslations("transit");
  const locale = useLocale();
  const isDelayed = departure.delaySeconds != null && departure.delaySeconds > 60;
  const isCanceled = departure.canceled === true;
  const hasRemarks = departure.remarks && departure.remarks.length > 0;

  const inner = (
    <>
      {/* Main row: destination left, time right */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            fontWeight={500}
            noWrap
            sx={{ textDecoration: isCanceled ? "line-through" : "none" }}
          >
            {departure.headsign}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.25 }}>
            <RouteBadge
              shortName={departure.route.shortName}
              color={departure.route.color}
              mode={departure.route.mode}
            />
            {showPlatform && departure.platform && (
              <Typography variant="caption" color="text.secondary">
                {t("platform")} {departure.platform}
              </Typography>
            )}
            {hasAlert && (
              <Tooltip title={t("activeServiceAlert")} placement="top" arrow>
                <WarningAmberIcon sx={{ fontSize: 14, color: "#E65100" }} />
              </Tooltip>
            )}
          </Box>
        </Box>
        {departure.occupancy && (
          <Tooltip title={t(OCCUPANCY_KEY[departure.occupancy])} placement="left" arrow>
            <AirlineSeatReclineNormalIcon
              sx={{ fontSize: 16, color: OCCUPANCY_COLOR[departure.occupancy], flexShrink: 0 }}
            />
          </Tooltip>
        )}
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <Typography
            variant="body2"
            fontWeight={500}
            sx={{
              textDecoration: isCanceled || isDelayed ? "line-through" : "none",
              color: isCanceled ? "text.disabled" : "text.primary",
            }}
          >
            {formatTime(departure.scheduledAt, locale)}
          </Typography>
          {isDelayed && !isCanceled && departure.expectedAt && (
            <Typography variant="body2" fontWeight={600} color="error.main">
              {formatTime(departure.expectedAt, locale)}
            </Typography>
          )}
          {isCanceled && (
            <Typography variant="caption" color="error.main" fontWeight={600}>
              {t("canceled")}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Trip remarks — in list view show only the top warning/cancellation; in detail view show all */}
      {hasRemarks && departure.remarks && (
        <Box sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.25 }}>
          {(onClick
            ? (() => {
                const urgent = departure.remarks.filter((r) => r.type !== "info");
                return urgent.length > 0 ? [topRemark(urgent)] : [];
              })()
            : departure.remarks
          ).map((remark, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static ordered remark list
            <RemarkChip key={i} remark={remark} inline />
          ))}
        </Box>
      )}
    </>
  );

  if (onClick) {
    return (
      <ButtonBase
        onClick={() => onClick(departure)}
        sx={{
          width: "100%",
          textAlign: "left",
          display: "block",
          py: 1,
          px: 1.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          opacity: isCanceled ? 0.5 : 1,
          "&:hover": { bgcolor: "action.hover" },
          transition: "background-color 0.12s",
        }}
      >
        {inner}
      </ButtonBase>
    );
  }

  return (
    <Box
      sx={{
        py: 1,
        px: 1.5,
        borderBottom: "1px solid",
        borderColor: "divider",
        opacity: isCanceled ? 0.5 : 1,
      }}
    >
      {inner}
    </Box>
  );
}
