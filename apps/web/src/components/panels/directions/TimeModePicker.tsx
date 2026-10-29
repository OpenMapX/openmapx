"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { BRAND } from "@/integration-api/runtime/theme";

export type TimeMode = "now" | "depart" | "arrive";

/** Format a Date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`, local wall-clock). */
export function toDateTimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The "Depart now / Depart at / Arrive by" tab row + date and time fields, shared by
 * the transit and driving directions flows. Controlled: the caller owns the
 * `timeMode` + `value` and maps them to its own state (the transit store vs the
 * local driving state), so the two flows stay independent.
 */
export function TimeModePicker({
  timeMode,
  value,
  onTimeModeChange,
  onValueChange,
}: {
  timeMode: TimeMode;
  /** Datetime for the active depart/arrive selection; null in "now" mode. */
  value: Date | null;
  onTimeModeChange: (mode: TimeMode) => void;
  onValueChange: (value: Date) => void;
}) {
  const t = useTranslations("directions");
  return (
    <Box sx={{ px: 2, pb: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ display: "flex", gap: 0.5 }}>
        {(["now", "depart", "arrive"] as const).map((m) => (
          <Box
            key={m}
            onClick={() => onTimeModeChange(m)}
            sx={{
              px: 1.5,
              py: 0.5,
              borderRadius: "8px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              bgcolor: timeMode === m ? BRAND : "action.hover",
              "&:hover": { bgcolor: timeMode === m ? BRAND : "action.selected" },
              transition: "background-color 0.15s",
            }}
          >
            <Typography
              variant="caption"
              color={timeMode === m ? "#fff" : "text.primary"}
              sx={{ fontWeight: 500 }}
            >
              {m === "now" ? t("departNow") : m === "depart" ? t("departAt") : t("arriveBy")}
            </Typography>
          </Box>
        ))}
      </Box>
      {timeMode !== "now" && (
        <DateTimeField
          label={timeMode === "depart" ? t("departAt") : t("arriveBy")}
          value={value ? toDateTimeLocalString(value) : ""}
          onChange={(next) => {
            if (next) onValueChange(new Date(next));
          }}
        />
      )}
    </Box>
  );
}
