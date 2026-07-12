"use client";

import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useTranslations } from "next-intl";
import { useMap } from "@/lib/MapContext";
import { useCrowdReportStore } from "./store";

/**
 * The "report a condition" FAB, styled like the My-Location pill in the
 * MapControls stack (IconButton in a rounded Paper). Opens the report dialog
 * pre-seeded with the current map center; the dialog offers "pick on map" and
 * severity from there.
 */
export function ReportFab() {
  const t = useTranslations("crowdReports");
  const { mapRef } = useMap();
  const openDialog = useCrowdReportStore((s) => s.openDialog);

  const handleClick = () => {
    const center = mapRef.current?.getCenter();
    openDialog(center ? [center.lng, center.lat] : null);
  };

  return (
    <Tooltip title={t("reportButton")} placement="left">
      <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
        <IconButton
          size="small"
          onClick={handleClick}
          sx={{ width: 36, height: 36 }}
          aria-label={t("reportButton")}
        >
          <ReportProblemOutlinedIcon sx={{ fontSize: 18, color: "primary.main" }} />
        </IconButton>
      </Paper>
    </Tooltip>
  );
}
