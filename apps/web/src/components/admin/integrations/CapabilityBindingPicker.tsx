"use client";

import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";

export interface CapabilityProvider {
  id: string;
  name: string;
}

export function CapabilityBindingPicker({
  capability,
  providers,
  value,
  onChange,
}: {
  capability: string;
  providers: CapabilityProvider[];
  value: string | null;
  onChange: (serviceId: string | null) => void;
}) {
  return (
    <TextField
      select
      size="small"
      label={capability}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      sx={{ minWidth: 240 }}
    >
      <MenuItem value="">(none — use fallback)</MenuItem>
      {providers.map((p) => (
        <MenuItem key={p.id} value={p.id}>
          {p.name} ({p.id})
        </MenuItem>
      ))}
    </TextField>
  );
}
