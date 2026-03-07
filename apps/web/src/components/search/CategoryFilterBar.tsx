"use client";

import AccessTimeIcon from "@mui/icons-material/AccessTime";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Popover from "@mui/material/Popover";
import Radio from "@mui/material/Radio";
import Typography from "@mui/material/Typography";
import type { OpeningHoursFilter } from "@openmapx/core";
import { useCategorySearchStore } from "@openmapx/core";
import { useEffect, useState } from "react";

const HOURS_FILTER_CATEGORIES = new Set([
  "restaurants",
  "hotels",
  "activities",
  "museums",
  "pharmacies",
  "cafes",
  "bars",
  "supermarkets",
  "hospitals",
  "doctors",
  "dentists",
  "gyms",
  "libraries",
  "cinemas",
  "banks",
  "car_repair",
]);

const TEAL = "#007b8b";

// Display order: Mon–Sun; JS day indices
const DAYS: { label: string; idx: number }[] = [
  { label: "Monday", idx: 1 },
  { label: "Tuesday", idx: 2 },
  { label: "Wednesday", idx: 3 },
  { label: "Thursday", idx: 4 },
  { label: "Friday", idx: 5 },
  { label: "Saturday", idx: 6 },
  { label: "Sunday", idx: 0 },
];

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const HOURS: { label: string; value: number | null }[] = [
  { label: "Any time", value: null },
  ...Array.from({ length: 24 }, (_, h) => ({
    label: `${String(h).padStart(2, "0")}:00`,
    value: h,
  })),
];

function chipLabel(
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
): string {
  if (filter === "open_now") return "Open now";
  if (filter === "open_24h") return "Open 24 hours";
  if (filter === "open_at") {
    const d = openAtDay !== null ? DAY_SHORT[openAtDay] : null;
    const h = openAtHour !== null ? `${String(openAtHour).padStart(2, "0")}:00` : null;
    if (d && h) return `${d} · ${h}`;
    if (d) return d;
    if (h) return h;
  }
  return "Opening times";
}

function PickerButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        width: "100%",
        px: 1.5,
        py: 0.75,
        border: "1px solid",
        borderColor: selected ? TEAL : "rgba(0,0,0,0.23)",
        borderRadius: "20px",
        bgcolor: selected ? "rgba(0,123,139,0.08)" : "transparent",
        color: selected ? TEAL : "text.primary",
        fontWeight: selected ? 600 : 400,
        fontSize: 13,
        cursor: "pointer",
        textAlign: "center",
        transition: "border-color 0.15s, background 0.15s",
        "&:hover": { borderColor: TEAL, bgcolor: "rgba(0,123,139,0.06)" },
      }}
    >
      {label}
    </Box>
  );
}

export function CategoryFilterBar() {
  const {
    activeCategory,
    openingHoursFilter,
    openAtDay,
    openAtHour,
    setOpeningHoursFilter,
    setOpenAtFilter,
  } = useCategorySearchStore();

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  // Pending state — committed only on Apply
  const [pendingMode, setPendingMode] = useState<OpeningHoursFilter>(openingHoursFilter);
  const [pendingDay, setPendingDay] = useState<number | null>(openAtDay);
  const [pendingHour, setPendingHour] = useState<number | null>(openAtHour);

  // Sync pending state from store when popover opens
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional sync on open
  useEffect(() => {
    if (anchorEl) {
      setPendingMode(openingHoursFilter);
      setPendingDay(openAtDay);
      setPendingHour(openAtHour);
    }
  }, [anchorEl]);

  if (!activeCategory || !HOURS_FILTER_CATEGORIES.has(activeCategory)) return null;

  const isFiltered = openingHoursFilter !== "any";
  const label = chipLabel(openingHoursFilter, openAtDay, openAtHour);

  const handleApply = () => {
    if (pendingMode === "open_at") {
      setOpenAtFilter(pendingDay, pendingHour);
    } else {
      setOpeningHoursFilter(pendingMode);
    }
    setAnchorEl(null);
  };

  const handleClear = () => {
    setPendingMode("any");
    setPendingDay(null);
    setPendingHour(null);
    setOpeningHoursFilter("any");
    setAnchorEl(null);
  };

  const radioSx = { color: TEAL, "&.Mui-checked": { color: TEAL }, p: 0.5 };

  return (
    <Box
      sx={{
        position: "absolute",
        top: { xs: 72, sm: 18 },
        left: { xs: 0, sm: 420 },
        right: { xs: 0, sm: 108 },
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        px: { xs: 1, sm: 0 },
        py: "2px",
        pointerEvents: "none",
      }}
    >
      <Chip
        icon={
          <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
            <AccessTimeIcon sx={{ fontSize: 16 }} />
          </Box>
        }
        label={
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {label}
            <ExpandMoreIcon
              sx={{
                fontSize: 16,
                transition: "transform 0.15s",
                transform: anchorEl ? "rotate(180deg)" : "none",
              }}
            />
          </Box>
        }
        onClick={(e) => setAnchorEl(e.currentTarget)}
        variant={isFiltered ? "filled" : "outlined"}
        sx={{
          pointerEvents: "auto",
          height: 36,
          borderRadius: "18px",
          fontWeight: 500,
          fontSize: 13,
          bgcolor: isFiltered ? TEAL : "background.paper",
          color: isFiltered ? "#fff" : "text.primary",
          borderColor: isFiltered ? TEAL : "rgba(0,0,0,0.23)",
          boxShadow: isFiltered ? "none" : "0 1px 3px rgba(0,0,0,0.15)",
          cursor: "pointer",
          userSelect: "none",
          "& .MuiChip-icon": { color: "inherit", ml: "10px", mr: "-4px" },
          "& .MuiChip-label": { pr: "10px" },
          "&&:hover": { bgcolor: isFiltered ? "#006475" : "grey.300" },
        }}
      />

      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        sx={{ mt: 0.5 }}
      >
        <Paper elevation={3} sx={{ width: 340, display: "flex", flexDirection: "column" }}>
          {/* Top radio group */}
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            {(
              [
                { value: "any", label: "Any time" },
                { value: "open_now", label: "Open now" },
                { value: "open_24h", label: "Open 24 hours" },
              ] as { value: OpeningHoursFilter; label: string }[]
            ).map((opt) => (
              <Box
                key={opt.value}
                component="label"
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 0.75,
                  cursor: "pointer",
                }}
              >
                <Radio
                  checked={pendingMode === opt.value}
                  onChange={() => setPendingMode(opt.value)}
                  size="small"
                  sx={radioSx}
                />
                <Typography variant="body2" fontSize={15}>
                  {opt.label}
                </Typography>
              </Box>
            ))}
          </Box>

          <Divider />

          {/* "Open at" option with day + time pickers */}
          <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
            <Box
              component="label"
              sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.75, cursor: "pointer" }}
            >
              <Radio
                checked={pendingMode === "open_at"}
                onChange={() => setPendingMode("open_at")}
                size="small"
                sx={radioSx}
              />
              <Typography variant="body2" fontSize={15}>
                Open at
              </Typography>
            </Box>

            {/* Day + Time grid — always visible but dims when mode isn't open_at */}
            <Box
              sx={{
                display: "flex",
                gap: 1,
                mt: 1,
                mb: 1,
                opacity: pendingMode === "open_at" ? 1 : 0.35,
                pointerEvents: pendingMode === "open_at" ? "auto" : "none",
              }}
            >
              {/* Days column */}
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, width: 130 }}>
                {DAYS.map((d) => (
                  <PickerButton
                    key={d.idx}
                    label={d.label}
                    selected={pendingDay === d.idx}
                    onClick={() => setPendingDay(pendingDay === d.idx ? null : d.idx)}
                  />
                ))}
              </Box>

              {/* Divider */}
              <Divider orientation="vertical" flexItem />

              {/* Time column — scrollable */}
              <Box
                sx={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.75,
                  maxHeight: 280,
                  overflowY: "auto",
                  pr: 0.5,
                  scrollbarWidth: "thin",
                }}
              >
                {HOURS.map((h) => (
                  <PickerButton
                    key={h.value ?? "any"}
                    label={h.label}
                    selected={pendingHour === h.value}
                    onClick={() => setPendingHour(pendingHour === h.value ? null : h.value)}
                  />
                ))}
              </Box>
            </Box>
          </Box>

          <Divider />

          {/* Footer */}
          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, px: 2, py: 1 }}>
            <Button
              variant="text"
              size="small"
              onClick={handleClear}
              sx={{ textTransform: "none", color: "text.secondary" }}
            >
              Clear
            </Button>
            <Button
              variant="text"
              size="small"
              onClick={handleApply}
              sx={{ textTransform: "none", color: TEAL, fontWeight: 600 }}
            >
              Apply
            </Button>
          </Box>
        </Paper>
      </Popover>
    </Box>
  );
}
