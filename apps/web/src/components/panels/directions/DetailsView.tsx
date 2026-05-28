"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { Route } from "@openmapx/core";
import { formatDistance, formatDuration } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ElevationProfile } from "@/components/elevation/ElevationProfile";
import { StepRow } from "@/components/panels/directions/StepRow";

export function DetailsView({
  route,
  originLabel,
  destinationLabel,
  waypointLabels,
  units,
  onBack,
}: {
  route: Route;
  originLabel: string;
  destinationLabel: string;
  waypointLabels?: string[];
  units: "metric" | "imperial";
  onBack: () => void;
}) {
  const t = useTranslations("directions");
  const hasLegs = route.legs && route.legs.length > 1;
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  // Build via string from intermediate waypoints
  const intermediateLabels = waypointLabels ? waypointLabels.slice(1, -1).filter(Boolean) : [];
  const viaStr =
    intermediateLabels.length > 0 ? t("via", { stops: intermediateLabels.join(", ") }) : undefined;

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.5, pt: 2, pb: 1 }}>
        <IconButton size="small" onClick={onBack} sx={{ mt: 0.25, flexShrink: 0 }}>
          <ArrowBackIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Box>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("from")}{" "}
            <Box
              component="span"
              sx={{
                fontWeight: 600,
                color: "text.primary",
              }}
            >
              {originLabel || t("origin")}
            </Box>
          </Typography>
          <br />
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("to")}{" "}
            <Box
              component="span"
              sx={{
                fontWeight: 600,
                color: "text.primary",
              }}
            >
              {destinationLabel || t("destination")}
            </Box>
          </Typography>
          {viaStr && (
            <>
              <br />
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {viaStr}
              </Typography>
            </>
          )}
        </Box>
      </Box>
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="h6"
          component="span"
          sx={{
            fontWeight: 600,
            color: "success.main",
          }}
        >
          {formatDuration(route.duration)}{" "}
        </Typography>
        <Typography
          variant="body1"
          component="span"
          sx={{
            color: "text.secondary",
          }}
        >
          ({dist})
        </Typography>
        {route.summary && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              display: "block",
            }}
          >
            {route.summary}
          </Typography>
        )}
      </Box>
      <Divider />
      {hasLegs ? (
        <LegByLegView
          route={route}
          waypointLabels={waypointLabels ?? [originLabel, destinationLabel]}
          units={units}
          t={t}
        />
      ) : (
        <>
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 700,
              }}
            >
              {originLabel || t("origin")}
            </Typography>
          </Box>
          {route.steps.map((step, i) => (
            <StepRow
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id
              key={i}
              instruction={step.instruction}
              distance={step.distance}
              duration={step.duration}
              units={units}
            />
          ))}
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 700,
              }}
            >
              {destinationLabel || t("destination")}
            </Typography>
          </Box>
        </>
      )}
      {route.mode !== "transit" && <ElevationProfile route={route} units={units} />}
    </Box>
  );
}

function LegByLegView({
  route,
  waypointLabels,
  units,
  t,
}: {
  route: Route;
  waypointLabels: string[];
  units: "metric" | "imperial";
  t: ReturnType<typeof useTranslations>;
}) {
  const [expandedLegs, setExpandedLegs] = useState<Set<number>>(
    () => new Set(route.legs.map((_, i) => i)),
  );

  const toggleLeg = (index: number) => {
    setExpandedLegs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <>
      {route.legs.map((leg, i) => {
        const fromLabel = waypointLabels[i] || t("origin");
        const toLabel = waypointLabels[i + 1] || t("destination");
        const legDist =
          units === "imperial"
            ? `${(leg.distance / 1609.34).toFixed(1)} mi`
            : formatDistance(leg.distance);
        const isExpanded = expandedLegs.has(i);

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
          <Box key={i}>
            <Box
              onClick={() => toggleLeg(i)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 2,
                py: 1.25,
                cursor: "pointer",
                bgcolor: "action.hover",
                "&:hover": { bgcolor: "action.selected" },
                transition: "background-color 0.15s",
                borderTop: "1px solid",
                borderColor: "divider",
              }}
            >
              <ExpandMoreIcon
                sx={{
                  fontSize: 20,
                  transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 0.2s",
                  color: "text.secondary",
                  flexShrink: 0,
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  noWrap
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {fromLabel} → {toLabel}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {formatDuration(leg.duration)} · {legDist}
                </Typography>
              </Box>
            </Box>
            <Collapse in={isExpanded}>
              <Box sx={{ px: 2, py: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                  }}
                >
                  {fromLabel}
                </Typography>
              </Box>
              {leg.steps.map((step, j) => (
                <StepRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id
                  key={j}
                  instruction={step.instruction}
                  distance={step.distance}
                  duration={step.duration}
                  units={units}
                />
              ))}
              <Box sx={{ px: 2, py: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                  }}
                >
                  {toLabel}
                </Typography>
              </Box>
            </Collapse>
          </Box>
        );
      })}
    </>
  );
}
