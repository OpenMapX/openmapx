"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { ChangeEvent } from "react";
import { BRAND } from "@/lib/theme";

export type TimeMode = "now" | "depart" | "arrive";

/** Format a Date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`, local wall-clock). */
export function toDateTimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The "Depart now / Depart at / Arrive by" tab row + datetime input, shared by
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
        <Box
          component="input"
          type="datetime-local"
          value={value ? toDateTimeLocalString(value) : ""}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const val = e.target.value;
            if (!val) return;
            onValueChange(new Date(val));
          }}
          sx={{
            border: "1px solid",
            borderColor: "divider",
            borderRadius: "8px",
            px: 1.5,
            py: 0.75,
            fontSize: "0.875rem",
            fontFamily: "inherit",
            color: "text.primary",
            bgcolor: "background.paper",
            outline: "none",
            "&:focus": { borderColor: BRAND },
            width: "100%",
            boxSizing: "border-box",
          }}
        />
      )}
    </Box>
  );
}
