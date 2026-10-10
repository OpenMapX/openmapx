"use client";

import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { Departure, TripRemark } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { departureRealtimeEvidence } from "@/lib/transit-data-status";
import { OccupancyIndicator } from "./OccupancyIndicator";
import { PlatformBadge } from "./PlatformBadge";
import { REMARK_PRIORITY, RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";
import { TransitDataStatus } from "./TransitDataStatus";

interface DepartureRowProps {
  departure: Departure;
  showPlatform?: boolean;
  freshness?: Freshness;
  queryFailed?: boolean;
  now?: number;
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
  freshness,
  queryFailed,
  now = Date.now(),
}: DepartureRowProps) {
  const t = useTranslations("transit");
  const fmt = useDateTimeFormat();
  const isDelayed = departure.delaySeconds != null && departure.delaySeconds > 60;
  const isCanceled = departure.canceled === true;
  const scheduledTime = fmt.time(departure.scheduledAt);
  const validExpectedAt =
    departure.expectedAt && Number.isFinite(Date.parse(departure.expectedAt))
      ? departure.expectedAt
      : undefined;
  const expectedTime = validExpectedAt ? fmt.time(validExpectedAt) : undefined;
  const timeChanged = expectedTime !== undefined && expectedTime !== scheduledTime;
  const hasRemarks = departure.remarks && departure.remarks.length > 0;

  const inner = (
    <>
      {/* Main row: destination left, time right */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            noWrap
            sx={{
              fontWeight: 500,
              textDecoration: isCanceled ? "line-through" : "none",
            }}
          >
            {departure.headsign}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.5, mt: 0.25 }}>
            <RouteBadge
              shortName={departure.route.shortName}
              color={departure.route.color}
              mode={departure.route.mode}
            />
            {showPlatform && departure.platform && (
              <PlatformBadge
                code={departure.platform}
                scheduledCode={departure.scheduledPlatform}
              />
            )}
            {hasAlert && (
              <Tooltip title={t("activeServiceAlert")} placement="top" arrow>
                <WarningAmberIcon sx={{ fontSize: 14, color: "#E65100" }} />
              </Tooltip>
            )}
          </Box>
        </Box>
        {departure.occupancy && <OccupancyIndicator level={departure.occupancy} size={16} />}
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
              textDecoration: isCanceled || timeChanged ? "line-through" : "none",
              color: isCanceled ? "text.disabled" : "text.primary",
            }}
          >
            {scheduledTime}
          </Typography>
          {timeChanged && !isCanceled && (
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: isDelayed ? "error.main" : "text.primary",
              }}
            >
              {expectedTime}
            </Typography>
          )}
          {isCanceled && (
            <Typography
              variant="caption"
              sx={{
                color: "error.main",
                fontWeight: 600,
              }}
            >
              {t("canceled")}
            </Typography>
          )}
        </Box>
      </Box>

      <TransitDataStatus
        now={now}
        realtime={departureRealtimeEvidence(departure)}
        freshness={freshness}
        source={departure.provenance?.instance}
        queryFailed={queryFailed}
      />

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
      }}
    >
      {inner}
    </Box>
  );
}
