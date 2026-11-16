"use client";

import MyLocationIcon from "@mui/icons-material/MyLocation";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

export function WaypointInput({
  value,
  placeholder,
  onChange,
  onUseMyLocation,
  onFocus,
  onBlur,
  useMyLocationLabel = "Use my location",
  trailing,
  onPress,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onUseMyLocation?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  useMyLocationLabel?: string;
  /** A control at the field's end, such as the stop-time button. */
  trailing?: ReactNode;
  /**
   * Makes the field a read-only button that opens a search instead (a phone's
   * trip card): no keyboard, and the press, not focus, starts the search.
   */
  onPress?: () => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1.5, minHeight: 38 }}>
      <Box
        component="input"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onFocus={onPress ? undefined : onFocus}
        onBlur={onPress ? undefined : onBlur}
        readOnly={Boolean(onPress)}
        onClick={onPress}
        onKeyDown={
          onPress
            ? (event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onPress();
                }
              }
            : undefined
        }
        placeholder={placeholder}
        sx={{
          flex: 1,
          border: "none",
          outline: "none",
          fontSize: 14,
          color: "text.primary",
          bgcolor: "transparent",
          minWidth: 0,
          cursor: onPress ? "pointer" : undefined,
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
      {trailing}
    </Box>
  );
}
