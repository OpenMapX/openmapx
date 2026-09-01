"use client";

import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useHotelSearchStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useEffect } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

const inputSx = {
  border: "1px solid",
  borderColor: "divider",
  borderRadius: 1.5,
  bgcolor: "background.paper",
  color: "text.primary",
  fontSize: 14,
  px: 1.25,
  py: 1,
  width: "100%",
  fontFamily: "inherit",
  "&:focus": { outline: "none", borderColor: BRAND },
} as const;

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const btnSx = {
    border: "1px solid",
    borderColor: "divider",
    bgcolor: "background.paper",
    borderRadius: "50%",
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: "text.primary",
    "&:hover": { borderColor: BRAND, color: BRAND },
    "&:disabled": { opacity: 0.4, cursor: "default" },
  } as const;
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <Typography variant="body2">{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          component="button"
          type="button"
          aria-label={`-${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          sx={btnSx}
        >
          <RemoveIcon sx={{ fontSize: 16 }} />
        </Box>
        <Typography variant="body2" sx={{ minWidth: 16, textAlign: "center", fontWeight: 600 }}>
          {value}
        </Typography>
        <Box
          component="button"
          type="button"
          aria-label={`+${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
          sx={btnSx}
        >
          <AddIcon sx={{ fontSize: 16 }} />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Check-in/check-out + occupancy controls, bound to the shared
 * useHotelSearchStore so the Overview block and Prices tab stay in sync.
 * Date inputs mirror FlightPanel's native date controls.
 */
export function HotelSearchControls() {
  const t = useTranslations("place");
  const { checkIn, checkOut, adults, rooms, setCheckIn, setCheckOut, setAdults, setRooms } =
    useHotelSearchStore();

  // Initialise default dates once on mount. Call via getState() so the effect
  // does not subscribe to the store / re-fire on later state changes and
  // overwrite a user edit (the codebase's idiom for one-shot init calls).
  useEffect(() => {
    useHotelSearchStore.getState().ensureDefaults();
  }, []);

  // "Today" floor for the date pickers, computed in LOCAL time to match the
  // store's defaultHotelDates/ymd. (toISOString() is UTC, which would set min to
  // tomorrow for evening users in the Americas and reject the local-today default.)
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("checkIn")}
          </Typography>
          <Box
            component="input"
            type="date"
            min={todayStr}
            value={checkIn}
            // The store enforces check-out > check-in, so the handler is a
            // plain setter (no duplicated guard here — DRY).
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCheckIn(e.target.value)}
            sx={inputSx}
          />
        </Box>
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("checkOut")}
          </Typography>
          <Box
            component="input"
            type="date"
            min={checkIn || todayStr}
            value={checkOut}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCheckOut(e.target.value)}
            sx={inputSx}
          />
        </Box>
      </Box>
      <Stepper label={t("guests")} value={adults} min={1} max={16} onChange={setAdults} />
      <Stepper label={t("rooms")} value={rooms} min={1} max={8} onChange={setRooms} />
    </Box>
  );
}
