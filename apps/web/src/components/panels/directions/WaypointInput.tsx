"use client";

import MyLocationIcon from "@mui/icons-material/MyLocation";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import type { ChangeEvent } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

export function WaypointInput({
  value,
  placeholder,
  onChange,
  onUseMyLocation,
  onFocus,
  onBlur,
  useMyLocationLabel = "Use my location",
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onUseMyLocation?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  useMyLocationLabel?: string;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", px: 1.25, py: 0.625 }}>
      <Box
        component="input"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        sx={{
          flex: 1,
          border: "none",
          outline: "none",
          fontSize: 14,
          color: "text.primary",
          bgcolor: "transparent",
          minWidth: 0,
          "::placeholder": { color: "text.secondary" },
        }}
      />
      {onUseMyLocation && (
        <Tooltip title={useMyLocationLabel}>
          <IconButton
            size="small"
            onClick={onUseMyLocation}
            sx={{ color: BRAND, p: 0.25, flexShrink: 0 }}
          >
            <MyLocationIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
