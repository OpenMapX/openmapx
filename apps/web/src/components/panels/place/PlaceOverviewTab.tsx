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
import PhoneIcon from "@mui/icons-material/Phone";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { computePlusCode, parseOpeningHours, plusCodeUrl, shortenPlusCode } from "@openmapx/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { PlaceActionButtons } from "./PlaceActionButtons";

interface Props {
  place: Place;
  isLoading: boolean;
  onNavigateToInfo: () => void;
}

const TEAL = "#007b8b";

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
    navigator.clipboard.writeText(copyValue).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

export function PlaceOverviewTab({ place, isLoading, onNavigateToInfo }: Props) {
  const hours = parseOpeningHours(place.openingHours);
  const plusCode = computePlusCode(place.coordinates);
  const shortCode = shortenPlusCode(plusCode);
  const city = place.city ?? null;
  const shortCodeDisplay = city ? `${shortCode} ${city}` : null;
  const [hoursExpanded, setHoursExpanded] = useState(false);

  return (
    <Box sx={{ px: 2, pt: 1.5, pb: 2 }}>
      {/* Action buttons */}
      <PlaceActionButtons place={place} />

      {/* Description — clickable row leading to Info tab */}
      {place.description && <Divider sx={{ my: 1 }} />}
      {place.description && (
        <Box
          onClick={onNavigateToInfo}
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

        {/* Opening hours */}
        {isLoading && !place.openingHours ? (
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
                    <Typography variant="body2" component="span" color="text.secondary">
                      {" · "}
                      {hours.detail}
                    </Typography>
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
  );
}
