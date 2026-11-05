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
      component="dl"
      direction={{ xs: "column", sm: "row" }}
      sx={{
        m: 0,
        gap: { xs: 0.25, sm: 1 },
        alignItems: "flex-start",
      }}
    >
      <Typography
        component="dt"
        variant="body2"
        sx={{
          color: "text.secondary",
          minWidth: { sm: labelWidth },
          flexShrink: 0,
        }}
      >
        {label}
      </Typography>
      <Box component="dd" sx={{ m: 0, minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>
        {typeof value === "string" ? <Typography variant="body2">{value}</Typography> : value}
      </Box>
    </Stack>
  );
}
