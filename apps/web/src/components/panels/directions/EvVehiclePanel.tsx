"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useDirectionsStore, useSettingsStore } from "@openmapx/core";
import { COMMON_EV_NETWORKS, VEHICLE_PRESETS } from "@openmapx/ev-charge-planner";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { TEAL } from "@/lib/theme";

const HOME_CURRENCIES = ["EUR", "USD", "GBP", "CHF"];

/** Acronym segments a hyphen-split vehicle preset id keeps upper-cased, e.g. "vw-id4" → "VW Id4". */
const ACRONYM_SEGMENTS = new Set(["vw", "bmw"]);

export function prettifyVehicleId(id: string): string {
  return id
    .split("-")
    .map((segment) =>
      ACRONYM_SEGMENTS.has(segment)
        ? segment.toUpperCase()
        : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join(" ");
}

const VEHICLE_OPTIONS = Object.keys(VEHICLE_PRESETS)
  .map((id) => ({ id, label: prettifyVehicleId(id) }))
  .sort((a, b) => a.label.localeCompare(b.label));

/**
 * EV trip inputs: vehicle + state-of-charge, network preferences,
 * cheaper-charging bias and home electricity price. Persisted
 * fields (`vehicleId`, `socTargetPct`, network prefs, `preferCheaper`, home
 * price/currency) live in the settings store like other user prefs;
 * `socStartPct`/`socArrivalMinPct` are transient (in-memory only) in the
 * directions store, since the current battery level changes every trip.
 */
export function EvVehiclePanel() {
  const t = useTranslations("directions.ev");
  const [avoidedExpanded, setAvoidedExpanded] = useState(false);

  const evSocStartPct = useDirectionsStore((s) => s.evSocStartPct);
  const setEvSocStartPct = useDirectionsStore((s) => s.setEvSocStartPct);
  const evSocArrivalMinPct = useDirectionsStore((s) => s.evSocArrivalMinPct);
  const setEvSocArrivalMinPct = useDirectionsStore((s) => s.setEvSocArrivalMinPct);

  const evVehicleId = useSettingsStore((s) => s.evVehicleId);
  const setEvVehicleId = useSettingsStore((s) => s.setEvVehicleId);
  const evSocTargetPct = useSettingsStore((s) => s.evSocTargetPct);
  const setEvSocTargetPct = useSettingsStore((s) => s.setEvSocTargetPct);
  const evPreferredNetworks = useSettingsStore((s) => s.evPreferredNetworks);
  const setEvPreferredNetworks = useSettingsStore((s) => s.setEvPreferredNetworks);
  const evAvoidedNetworks = useSettingsStore((s) => s.evAvoidedNetworks);
  const setEvAvoidedNetworks = useSettingsStore((s) => s.setEvAvoidedNetworks);
  const evExclusiveNetworks = useSettingsStore((s) => s.evExclusiveNetworks);
  const setEvExclusiveNetworks = useSettingsStore((s) => s.setEvExclusiveNetworks);
  const evPreferCheaper = useSettingsStore((s) => s.evPreferCheaper);
  const setEvPreferCheaper = useSettingsStore((s) => s.setEvPreferCheaper);
  const evHomePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const setEvHomePricePerKwh = useSettingsStore((s) => s.setEvHomePricePerKwh);
  const evHomeCurrency = useSettingsStore((s) => s.evHomeCurrency);
  const setEvHomeCurrency = useSettingsStore((s) => s.setEvHomeCurrency);

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <FormControl size="small" fullWidth>
        <InputLabel id="ev-vehicle-select-label">{t("vehicle")}</InputLabel>
        <Select
          labelId="ev-vehicle-select-label"
          label={t("vehicle")}
          value={evVehicleId ?? ""}
          displayEmpty
          onChange={(e) => setEvVehicleId(e.target.value || null)}
        >
          <MenuItem value="">
            <em>{t("selectVehicle")}</em>
          </MenuItem>
          {VEHICLE_OPTIONS.map((v) => (
            <MenuItem key={v.id} value={v.id}>
              {v.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box sx={{ display: "flex", gap: 1.5 }}>
        <TextField
          size="small"
          type="number"
          label={t("batteryStart")}
          value={evSocStartPct}
          onChange={(e) => setEvSocStartPct(clampPct(Number(e.target.value)))}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { min: 0, max: 100 },
          }}
          fullWidth
        />
        <TextField
          size="small"
          type="number"
          label={t("socTarget")}
          value={evSocTargetPct}
          onChange={(e) => setEvSocTargetPct(clampPct(Number(e.target.value)))}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { min: 0, max: 100 },
          }}
          fullWidth
        />
        <TextField
          size="small"
          type="number"
          label={t("socArrivalMin")}
          value={evSocArrivalMinPct}
          onChange={(e) => setEvSocArrivalMinPct(clampPct(Number(e.target.value)))}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { min: 0, max: 100 },
          }}
          fullWidth
        />
      </Box>

      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
          {t("preferredNetworks")}
        </Typography>
        <Autocomplete
          multiple
          freeSolo
          size="small"
          options={COMMON_EV_NETWORKS}
          value={evPreferredNetworks}
          onChange={(_event, newValue) => setEvPreferredNetworks(newValue as string[])}
          renderInput={(params) => <TextField {...params} variant="outlined" size="small" />}
        />
      </Box>

      <Box>
        <Typography
          variant="body2"
          onClick={() => setAvoidedExpanded((v) => !v)}
          sx={{
            fontWeight: 600,
            mb: 0.5,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 0.5,
          }}
        >
          {t("avoidedNetworks")}
          <ExpandMoreIcon
            sx={{
              fontSize: 18,
              transform: avoidedExpanded ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }}
          />
        </Typography>
        {avoidedExpanded && (
          <Autocomplete
            multiple
            freeSolo
            size="small"
            options={COMMON_EV_NETWORKS}
            value={evAvoidedNetworks}
            onChange={(_event, newValue) => setEvAvoidedNetworks(newValue as string[])}
            renderInput={(params) => <TextField {...params} variant="outlined" size="small" />}
          />
        )}
      </Box>

      <FormControlLabel
        control={
          <Checkbox
            checked={evExclusiveNetworks}
            disabled={evPreferredNetworks.length === 0}
            onChange={(e) => setEvExclusiveNetworks(e.target.checked)}
            sx={{ color: TEAL, "&.Mui-checked": { color: TEAL } }}
          />
        }
        label={t("exclusiveNetworks")}
      />

      <FormControlLabel
        control={
          <Switch
            checked={evPreferCheaper}
            onChange={(e) => setEvPreferCheaper(e.target.checked)}
            sx={{ "& .MuiSwitch-switchBase.Mui-checked": { color: TEAL } }}
          />
        }
        label={t("preferCheaper")}
      />

      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
        <TextField
          size="small"
          type="number"
          label={t("homePrice")}
          value={evHomePricePerKwh ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setEvHomePricePerKwh(v === "" ? null : Math.max(0, Number(v)));
          }}
          helperText={t("homePriceHint")}
          slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
          fullWidth
        />
        <FormControl size="small" sx={{ minWidth: 90 }}>
          <InputLabel id="ev-home-currency-label">{t("currency")}</InputLabel>
          <Select
            labelId="ev-home-currency-label"
            label={t("currency")}
            value={evHomeCurrency}
            onChange={(e) => setEvHomeCurrency(e.target.value)}
          >
            {HOME_CURRENCIES.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
  );
}

function clampPct(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(100, Math.max(0, v));
}
