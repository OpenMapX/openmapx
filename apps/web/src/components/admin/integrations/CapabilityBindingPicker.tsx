"use client";

import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { useTranslations } from "next-intl";

export interface CapabilityProvider {
  id: string;
  name: string;
}

export function CapabilityBindingPicker({
  capability,
  providers,
  value,
  onChange,
  disabled = false,
}: {
  capability: string;
  providers: CapabilityProvider[];
  value: string | null;
  onChange: (serviceId: string | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("adminIntegrations");
  return (
    <TextField
      select
      disabled={disabled}
      size="small"
      label={capability}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      sx={{ minWidth: 240 }}
    >
      <MenuItem value="">{t("noneUseFallback")}</MenuItem>
      {providers.map((p) => (
        <MenuItem key={p.id} value={p.id}>
          {p.name} ({p.id})
        </MenuItem>
      ))}
    </TextField>
  );
}
