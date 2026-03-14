"use client";

import AccessTimeIcon from "@mui/icons-material/AccessTime";
import AppsIcon from "@mui/icons-material/Apps";
import ArticleIcon from "@mui/icons-material/Article";
import CheckIcon from "@mui/icons-material/Check";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LanguageIcon from "@mui/icons-material/Language";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import PhoneIcon from "@mui/icons-material/Phone";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type {
  DaySchedule,
  FuelPrices,
  FuelStationDetail,
  MergedDeparture,
  MergedRoute,
  OpeningHoursStatus,
  Place,
  TransportMode,
} from "@openmapx/core";
import {
  computePlusCode,
  parseOpeningHours,
  plusCodeUrl,
  shortenPlusCode,
  useFuelStationDetail,
} from "@openmapx/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { FuelPrice } from "@/components/ui/FuelPrice";
import { TEAL } from "@/lib/theme";
import { PlaceTransitSection } from "../transit/PlaceTransitSection";
import { PlaceActionButtons } from "./PlaceActionButtons";

interface Props {
  place: Place;
  isLoading: boolean;
  onNavigateToInfo: () => void;
  onOpenDepartures: (mode?: TransportMode) => void;
  onOpenLineDetail: (route: MergedRoute) => void;
  onOpenTripDetail?: (dep: MergedDeparture) => void;
}

function DetailRow({
  icon,
  children,
  copyValue,
  copyLabel = "Copy",
}: {
  icon: ReactNode;
  children: ReactNode;
  copyValue?: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!copyValue) return;
    navigator.clipboard.writeText(copyValue).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  return (
    <Box
      sx={{
        display: "flex",
        gap: 2,
        alignItems: "center",
        py: 1.25,
        ...(copyValue
          ? {
              mx: -2,
              px: 2,
              "&:hover": { bgcolor: "action.hover" },
              "& .copy-btn": { opacity: 0 },
              "&:hover .copy-btn": { opacity: 1 },
            }
          : {}),
      }}
    >
      <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
      {copyValue && (
        <Tooltip title={copied ? "Copied!" : copyLabel}>
          <IconButton
            className="copy-btn"
            size="small"
            onClick={handleCopy}
            sx={{ color: "text.secondary", flexShrink: 0, p: 0.5, transition: "opacity 0.15s" }}
          >
            {copied ? (
              <CheckIcon sx={{ fontSize: 18 }} />
            ) : (
              <ContentCopyIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

function fuelDetailToHours(detail: FuelStationDetail): OpeningHoursStatus {
  if (detail.wholeDay) {
    return { isOpen: detail.isOpen, label: "Open 24 hours", detail: "Open 24 hours" };
  }
  const weekSchedule: DaySchedule[] = detail.openingTimes.map((t) => ({
    day: t.text,
    hours: `${t.start.slice(0, 5)}–${t.end.slice(0, 5)}`,
    isToday: false,
  }));
  return {
    isOpen: detail.isOpen,
    label: detail.isOpen ? "Open" : "Closed",
    detail: "",
    weekSchedule: weekSchedule.length > 0 ? weekSchedule : undefined,
  };
}

function formatPriceAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(diffMs / 86_400_000)}d ago`;
}

function FuelPricesRow({
  prices,
  updatedAt,
  attribution,
}: {
  prices: FuelPrices;
  updatedAt?: string;
  attribution?: { label: string; url: string };
}) {
  const fuels: { label: string; value: number }[] = [];
  if (prices.diesel !== undefined) fuels.push({ label: "Diesel", value: prices.diesel });
  if (prices.e5 !== undefined) fuels.push({ label: "E5", value: prices.e5 });
  if (prices.e10 !== undefined) fuels.push({ label: "E10", value: prices.e10 });
  if (fuels.length === 0) return null;

  return (
    <Box sx={{ display: "flex", gap: 2, alignItems: "center", py: 1.25 }}>
      <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>
        <LocalGasStationIcon sx={{ fontSize: 22 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {fuels.map((f) => (
            <Chip
              key={f.label}
              label={
                <>
                  {f.label}
                  {"  "}
                  <FuelPrice value={f.value} />
                </>
              }
              size="small"
              variant="outlined"
              sx={{ fontSize: 12, height: 24 }}
            />
          ))}
        </Box>
        {(attribution || updatedAt) && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
            {"Live prices"}
            {updatedAt && ` · Updated ${formatPriceAge(updatedAt)}`}
            {attribution && (
              <>
                {" · "}
                <Link
                  href={attribution.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  sx={{ color: "text.secondary" }}
                >
                  {attribution.label}
                </Link>
              </>
            )}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function PlaceOverviewTab({
  place,
  isLoading,
  onNavigateToInfo,
  onOpenDepartures,
  onOpenLineDetail,
  onOpenTripDetail,
}: Props) {
  const { data: fuelDetail } = useFuelStationDetail(place.id);
  const hours = fuelDetail ? fuelDetailToHours(fuelDetail) : parseOpeningHours(place.openingHours);
  const plusCode = computePlusCode(place.coordinates);
  const shortCode = shortenPlusCode(plusCode);
  const city = place.city ?? null;
  const shortCodeDisplay = city ? `${shortCode} ${city}` : null;
  const [hoursExpanded, setHoursExpanded] = useState(false);

  return (
    <>
      <Box sx={{ px: 2, pt: 1.5, pb: 2 }}>
        {/* Action buttons */}
        <PlaceActionButtons place={place} />

        {/* Description — clickable row leading to Info tab */}
        {place.description && <Divider sx={{ my: 1 }} />}
        {place.description && (
          <Box
            role="button"
            tabIndex={0}
            onClick={onNavigateToInfo}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onNavigateToInfo();
              }
            }}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              cursor: "pointer",
              py: 1.5,
              mx: -2,
              px: 2,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Typography variant="body2" sx={{ flex: 1, color: "rgba(0,0,0,0.87)" }}>
              {place.description}
            </Typography>
            <ChevronRightIcon sx={{ fontSize: 20, color: "text.disabled", flexShrink: 0 }} />
          </Box>
        )}

        <Divider sx={{ my: 1 }} />

        {/* Detail rows */}
        <Box sx={{ px: 0 }}>
          {/* Address */}
          <DetailRow
            icon={<PlaceIcon sx={{ fontSize: 22 }} />}
            copyValue={place.address}
            copyLabel="Copy address"
          >
            <Typography variant="body2" color="rgba(0,0,0,0.87)">
              {place.address}
            </Typography>
          </DetailRow>

          {/* Plus Code */}
          <DetailRow
            icon={<AppsIcon sx={{ fontSize: 22 }} />}
            copyValue={shortCodeDisplay ?? plusCode}
            copyLabel="Copy Plus Code"
          >
            <Link
              href={plusCodeUrl(plusCode)}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              sx={{ display: "block", color: "rgba(0,0,0,0.87)", typography: "body2" }}
            >
              {shortCodeDisplay ?? plusCode}
            </Link>
            {shortCodeDisplay && (
              <Typography variant="caption" color="text.secondary">
                {plusCode}
              </Typography>
            )}
          </DetailRow>

          {/* Fuel prices */}
          {place.fuelPrices && (
            <FuelPricesRow
              prices={place.fuelPrices}
              updatedAt={place.fuelPricesUpdatedAt}
              attribution={place.fuelAttribution}
            />
          )}

          {/* Opening hours — Tankerkoenig detail takes priority over OSM */}
          {isLoading && !place.openingHours && !fuelDetail ? (
            <DetailRow icon={<AccessTimeIcon sx={{ fontSize: 22 }} />}>
              <Skeleton variant="text" width="60%" />
            </DetailRow>
          ) : (
            hours && (
              <Box
                onClick={hours.weekSchedule ? () => setHoursExpanded((v) => !v) : undefined}
                sx={{
                  display: "flex",
                  gap: 2,
                  alignItems: "flex-start",
                  py: 1.25,
                  ...(hours.weekSchedule
                    ? { cursor: "pointer", mx: -2, px: 2, "&:hover": { bgcolor: "action.hover" } }
                    : {}),
                }}
              >
                <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: "2px" }}>
                  <AccessTimeIcon sx={{ fontSize: 22 }} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {/* Status row */}
                  <Box sx={{ display: "flex", alignItems: "center" }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography
                        variant="body2"
                        component="span"
                        fontWeight={500}
                        color={hours.isOpen ? "success.main" : "error.main"}
                      >
                        {hours.isOpen ? "Open" : "Closed"}
                      </Typography>
                      {hours.detail && (
                        <Typography variant="body2" component="span" color="text.secondary">
                          {" · "}
                          {hours.detail}
                        </Typography>
                      )}
                    </Box>
                    {hours.weekSchedule &&
                      (hoursExpanded ? (
                        <ExpandLessIcon
                          sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0, ml: 0.5 }}
                        />
                      ) : (
                        <ExpandMoreIcon
                          sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0, ml: 0.5 }}
                        />
                      ))}
                  </Box>

                  {/* Expanded weekly schedule */}
                  {hoursExpanded && hours.weekSchedule && (
                    <Box sx={{ mt: 1, mb: 0.5 }}>
                      {hours.weekSchedule.map(({ day, hours: h, isToday }) => (
                        <Box key={day} sx={{ display: "flex", gap: 2, py: 0.4 }}>
                          <Typography
                            variant="body2"
                            fontWeight={isToday ? 600 : 400}
                            color={isToday ? "text.primary" : "text.secondary"}
                            sx={{ width: 96, flexShrink: 0 }}
                          >
                            {day}
                          </Typography>
                          <Typography
                            variant="body2"
                            fontWeight={isToday ? 600 : 400}
                            color={isToday ? "text.primary" : "text.secondary"}
                          >
                            {h}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              </Box>
            )
          )}

          {/* Phone */}
          {isLoading && !place.phone ? (
            <DetailRow icon={<PhoneIcon sx={{ fontSize: 22 }} />}>
              <Skeleton variant="text" width="45%" />
            </DetailRow>
          ) : (
            place.phone && (
              <DetailRow
                icon={<PhoneIcon sx={{ fontSize: 22 }} />}
                copyValue={place.phone}
                copyLabel="Copy phone number"
              >
                <Link
                  href={`tel:${place.phone}`}
                  variant="body2"
                  underline="hover"
                  sx={{ color: "rgba(0,0,0,0.87)" }}
                >
                  {place.phone}
                </Link>
              </DetailRow>
            )
          )}

          {/* Website */}
          {isLoading && !place.website ? (
            <DetailRow icon={<LanguageIcon sx={{ fontSize: 22 }} />}>
              <Skeleton variant="text" width="55%" />
            </DetailRow>
          ) : (
            place.website && (
              <DetailRow
                icon={<LanguageIcon sx={{ fontSize: 22 }} />}
                copyValue={place.website}
                copyLabel="Copy website"
              >
                <Link
                  href={place.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                  underline="hover"
                  sx={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "rgba(0,0,0,0.87)",
                  }}
                >
                  {place.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                </Link>
              </DetailRow>
            )
          )}

          {/* Wikipedia */}
          {place.wikipediaUrl && (
            <DetailRow icon={<ArticleIcon sx={{ fontSize: 22 }} />}>
              <Link
                href={place.wikipediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                variant="body2"
                underline="hover"
                sx={{ color: "rgba(0,0,0,0.87)" }}
              >
                Wikipedia
              </Link>
            </DetailRow>
          )}
        </Box>
      </Box>
      {/* Transit section — self-hides if no linked stops */}
      <PlaceTransitSection
        place={place}
        onOpenDepartures={onOpenDepartures}
        onOpenLineDetail={onOpenLineDetail}
        onOpenTripDetail={onOpenTripDetail}
      />
    </>
  );
}
