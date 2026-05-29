"use client";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

interface MetaRowProps {
  label: string;
  value: React.ReactNode;
  /** Label column width (matches the per-call-site `minWidth`). Defaults to 130. */
  labelWidth?: number;
}

export function MetaRow({ label, value, labelWidth = 130 }: MetaRowProps) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <Stack
      direction="row"
      sx={{
        gap: 1,
        alignItems: "flex-start",
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          minWidth: labelWidth,
          flexShrink: 0,
        }}
      >
        {label}
      </Typography>
      <Box>
        {typeof value === "string" ? <Typography variant="body2">{value}</Typography> : value}
      </Box>
    </Stack>
  );
}
