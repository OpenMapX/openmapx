"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ScheduleIcon from "@mui/icons-material/Schedule";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { ClickableRow } from "@/components/ui/ClickableRow";
import { BRAND } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import type { TimeMode } from "./TimeModePicker";

interface TripTimeChipProps {
  mode: TimeMode;
  value: Date | null;
  open: boolean;
  onToggle: () => void;
}

/** Leave now / depart at / arrive by, for transit and timed driving. */
export function TripTimeChip({ mode, value, open, onToggle }: TripTimeChipProps) {
  const t = useTranslations("directions");
  const fmt = useDateTimeFormat();
  const timed = mode !== "now";
  const clock = value ? fmt.time(value) : "";
  const label =
    mode === "now"
      ? t("departNow")
      : `${mode === "depart" ? t("departAt") : t("arriveBy")} ${clock}`;
  return (
    <ClickableRow
      aria-expanded={open}
      onClick={onToggle}
      sx={{
        width: "auto",
        gap: 0.75,
        px: 1.75,
        py: 0.75,
        borderRadius: "12px",
        bgcolor: timed ? `${BRAND}18` : "action.hover",
        "&:hover": { bgcolor: timed ? `${BRAND}28` : "action.selected" },
        transition: "background-color 0.15s",
      }}
    >
      <ScheduleIcon sx={{ fontSize: 18, color: timed ? BRAND : "text.primary" }} />
      <Typography variant="body2" color={timed ? BRAND : "text.primary"} sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
      <ExpandMoreIcon sx={{ fontSize: 18, color: timed ? BRAND : "text.primary" }} />
    </ClickableRow>
  );
}
