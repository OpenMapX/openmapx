"use client";

import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { BRAND } from "@/integration-api/runtime/theme";

const buttonSx = {
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
  "&:disabled": {
    opacity: 0.4,
    cursor: "default",
    "&:hover": { borderColor: "divider", color: "text.primary" },
  },
} as const;

/**
 * A labelled count with minus and plus buttons, clamped to `min`..`max`, for
 * passengers, guests and rooms. `dim` greys the row out when the value will
 * not be used (a provider that cannot take it), while keeping it editable.
 */
export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  dim = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  dim?: boolean;
}) {
  return (
    <Box
      role="group"
      aria-label={label}
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        opacity: dim ? 0.5 : 1,
      }}
    >
      <Typography variant="body2">{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          component="button"
          type="button"
          aria-label={`-${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          sx={buttonSx}
        >
          <RemoveIcon sx={{ fontSize: 16 }} />
        </Box>
        <Typography
          variant="body2"
          aria-live="polite"
          sx={{ minWidth: 16, textAlign: "center", fontWeight: 600 }}
        >
          {value}
        </Typography>
        <Box
          component="button"
          type="button"
          aria-label={`+${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
          sx={buttonSx}
        >
          <AddIcon sx={{ fontSize: 16 }} />
        </Box>
      </Box>
    </Box>
  );
}
