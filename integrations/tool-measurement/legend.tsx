"use client";

import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RedoIcon from "@mui/icons-material/Redo";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import TimelineIcon from "@mui/icons-material/Timeline";
import UndoIcon from "@mui/icons-material/Undo";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { LngLat, MeasurementMode, UnitSystem } from "@openmapx/core";
import { formatArea, formatMeasurementDistance } from "@openmapx/core";
import { area } from "@turf/area";
import { lineString, polygon as turfPolygon } from "@turf/helpers";
import { length } from "@turf/length";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useMeasurementStore } from "./store";

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

export function MeasurementToolbar() {
  const t = useTranslations("measurement");
  const isActive = useMeasurementStore((s) => s.isActive);
  const mode = useMeasurementStore((s) => s.mode);
  const points = useMeasurementStore((s) => s.points);
  const undonePoints = useMeasurementStore((s) => s.undonePoints);
  const unitSystem = useMeasurementStore((s) => s.unitSystem);
  const isFinalized = useMeasurementStore((s) => s.isFinalized);
  const setMode = useMeasurementStore((s) => s.setMode);
  const setUnitSystem = useMeasurementStore((s) => s.setUnitSystem);
  const undo = useMeasurementStore((s) => s.undo);
  const redo = useMeasurementStore((s) => s.redo);
  const clear = useMeasurementStore((s) => s.clear);
  const deactivate = useMeasurementStore((s) => s.deactivate);

  const measurementText = useMemo(() => {
    if (mode === "line") {
      if (points.length < 2) return t("clickToStart");
      const dist = computeTotalDistance(points);
      return `${t("total")}: ${formatMeasurementDistance(dist, unitSystem)}`;
    }
    if (points.length < 3) return t("clickToStart");
    if (!isFinalized) return t("clickToClose");
    const a = computePolygonArea(points);
    const p = computePerimeter(points);
    return `${formatArea(a, unitSystem)} | ${t("perimeter")}: ${formatMeasurementDistance(p, unitSystem)}`;
  }, [points, mode, unitSystem, isFinalized, t]);

  if (!isActive) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: "12px",
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
        justifyContent: "center",
        maxWidth: { xs: "calc(100vw - 24px)", sm: 560 },
      }}
    >
      {/* Mode toggle */}
      <ToggleButtonGroup
        value={mode}
        exclusive
        size="small"
        onChange={(_, v: MeasurementMode | null) => {
          if (v) setMode(v);
        }}
        sx={{ "& .MuiToggleButton-root": { px: 1, py: 0.5 } }}
      >
        <ToggleButton value="line" aria-label={t("lineMode")}>
          <Tooltip title={t("lineMode")}>
            <ShowChartIcon sx={{ fontSize: 20 }} />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="polygon" aria-label={t("polygonMode")}>
          <Tooltip title={t("polygonMode")}>
            <TimelineIcon sx={{ fontSize: 20 }} />
          </Tooltip>
        </ToggleButton>
      </ToggleButtonGroup>

      <Divider orientation="vertical" flexItem />

      {/* Measurement display */}
      <Typography
        sx={{
          fontSize: 13,
          fontWeight: 600,
          color: "text.primary",
          whiteSpace: "nowrap",
          minWidth: 80,
          textAlign: "center",
        }}
      >
        {measurementText}
      </Typography>

      <Divider orientation="vertical" flexItem />

      {/* Unit toggle */}
      <ToggleButtonGroup
        value={unitSystem}
        exclusive
        size="small"
        onChange={(_, v: UnitSystem | null) => {
          if (v) setUnitSystem(v);
        }}
        sx={{ "& .MuiToggleButton-root": { px: 0.8, py: 0.3, fontSize: 11 } }}
      >
        <ToggleButton value="metric">km</ToggleButton>
        <ToggleButton value="imperial">mi</ToggleButton>
      </ToggleButtonGroup>

      <Divider orientation="vertical" flexItem />

      {/* Action buttons */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
        <Tooltip title={t("undo")}>
          <span>
            <IconButton
              size="small"
              onClick={undo}
              disabled={points.length === 0}
              aria-label={t("undo")}
            >
              <UndoIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("redo")}>
          <span>
            <IconButton
              size="small"
              onClick={redo}
              disabled={undonePoints.length === 0}
              aria-label={t("redo")}
            >
              <RedoIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("clearMeasurement")}>
          <span>
            <IconButton
              size="small"
              onClick={clear}
              disabled={points.length === 0}
              aria-label={t("clearMeasurement")}
            >
              <DeleteOutlineIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("closeTool")}>
          <IconButton size="small" onClick={deactivate} aria-label={t("closeTool")}>
            <CloseIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Paper>
  );
}
