"use client";

import Box from "@mui/material/Box";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

/** A titled group of setting rows. Shared by the settings dialogs. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography
        variant="overline"
        sx={{ color: "text.secondary", fontWeight: 600, display: "block", mb: 0.5 }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/** A label on the left, a control on the right. */
export function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
        py: 0.75,
      }}
    >
      <Typography variant="body2">{label}</Typography>
      <Box sx={{ minWidth: 180 }}>{children}</Box>
    </Box>
  );
}

/** A right-aligned switch, the common control for a boolean setting row. */
export function SwitchControl({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Box>
  );
}
