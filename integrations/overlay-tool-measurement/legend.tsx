"use client";

import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { LngLat } from "@openmapx/core";
import { formatArea, formatMeasurementDistance } from "@openmapx/core";
import { area } from "@turf/area";
import { lineString, polygon as turfPolygon } from "@turf/helpers";
import { length } from "@turf/length";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { type MeasurementMode, useMeasurementStore } from "./store";

function computeTotalDistance(points: LngLat[]): number {
  if (points.length < 2) return 0;
  return length(lineString(points), { units: "meters" });
}

function computePolygonArea(points: LngLat[]): number {
  if (points.length < 3) return 0;
  const ring = [...points, points[0]];
  return area(turfPolygon([ring]));
}

function computePerimeter(points: LngLat[]): number {
  if (points.length < 3) return 0;
  const ring = [...points, points[0]];
  return length(lineString(ring), { units: "meters" });
}

/**
 * The measuring tool's panel: what is measured (a distance or an area), the
 * result in large type, and undo, clear and close. Points are added on the map
 * itself; until there is something to show, the panel says how. Results use
 * the units the app is set to (the measurement's own, for a shared link).
 * Redo stays on its keyboard shortcut.
 */
export function MeasurementToolbar() {
  const t = useTranslations("measurement");
  const isActive = useMeasurementStore((s) => s.isActive);
  const mode = useMeasurementStore((s) => s.mode);
  const points = useMeasurementStore((s) => s.points);
  const unitSystem = useMeasurementStore((s) => s.unitSystem);
  const isFinalized = useMeasurementStore((s) => s.isFinalized);
  const setMode = useMeasurementStore((s) => s.setMode);
  const undo = useMeasurementStore((s) => s.undo);
  const clear = useMeasurementStore((s) => s.clear);
  const deactivate = useMeasurementStore((s) => s.deactivate);
  // A mouse clicks; a finger taps.
  const finePointer = useMediaQuery("(pointer: fine)");

  const result = useMemo(() => {
    if (mode === "line") {
      if (points.length < 2) return null;
      return {
        value: formatMeasurementDistance(computeTotalDistance(points), unitSystem),
        detail: null,
      };
    }
    if (points.length < 3 || !isFinalized) return null;
    return {
      value: formatArea(computePolygonArea(points), unitSystem),
      detail: t("perimeterValue", {
        distance: formatMeasurementDistance(computePerimeter(points), unitSystem),
      }),
    };
  }, [points, mode, unitSystem, isFinalized, t]);

  if (!isActive) return null;

  const hint =
    mode === "polygon" && points.length >= 3
      ? t(finePointer ? "clickToClose" : "tapToClose")
      : t(finePointer ? "clickToStart" : "tapToStart");

  return (
    <Paper elevation={3} sx={{ width: { sm: 400 }, px: 2, pt: 1, pb: 1.5, borderRadius: "16px" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <ToggleButtonGroup
          value={mode}
          exclusive
          size="small"
          onChange={(_, v: MeasurementMode | null) => {
            if (v) setMode(v);
          }}
          // The same joined segments as the directions panel's vehicle switch.
          sx={{ "& .MuiToggleButton-root": { textTransform: "none", py: 0.3, px: 1.2 } }}
        >
          <ToggleButton value="line" aria-label={t("lineMode")}>
            {t("distance")}
          </ToggleButton>
          <ToggleButton value="polygon" aria-label={t("polygonMode")}>
            {t("area")}
          </ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t("undo")}>
          <span>
            <IconButton onClick={undo} disabled={points.length === 0} aria-label={t("undo")}>
              <UndoIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("clearMeasurement")}>
          <span>
            <IconButton
              onClick={clear}
              disabled={points.length === 0}
              aria-label={t("clearMeasurement")}
            >
              <DeleteOutlineIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("closeTool")}>
          <IconButton onClick={deactivate} aria-label={t("closeTool")}>
            <CloseIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box aria-live="polite" sx={{ mt: 0.5, minHeight: 36 }}>
        {result ? (
          <>
            <Typography sx={{ fontSize: 24, fontWeight: 600, lineHeight: 1.3 }}>
              {result.value}
            </Typography>
            {result.detail && (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {result.detail}
              </Typography>
            )}
          </>
        ) : (
          <Typography variant="body2" sx={{ color: "text.secondary", pt: 0.75 }}>
            {hint}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}
