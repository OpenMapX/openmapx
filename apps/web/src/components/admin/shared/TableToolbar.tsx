"use client";

import SearchIcon from "@mui/icons-material/Search";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import type { ReactNode } from "react";

/**
 * Responsive toolbar row for table search + filter controls. Wraps on narrow
 * screens. Place a {@link TableSearchField} and any number of MUI filter
 * controls (FormControl + Select, ToggleButtonGroup, …) inside it.
 */
export function TableToolbar({ children }: { children: ReactNode }) {
  return (
    <Stack
      direction="row"
      sx={{
        gap: 1,
        flexWrap: "wrap",
        alignItems: "center",
        minHeight: 40,
      }}
    >
      {children}
    </Stack>
  );
}

export interface TableSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minWidth?: number;
}

/** Standard search field with a leading magnifier icon for admin tables. */
export function TableSearchField({
  value,
  onChange,
  placeholder = "Search…",
  minWidth = 240,
}: TableSearchFieldProps) {
  return (
    <TextField
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        },
      }}
      sx={{ minWidth, flexGrow: 1, maxWidth: 360 }}
    />
  );
}
