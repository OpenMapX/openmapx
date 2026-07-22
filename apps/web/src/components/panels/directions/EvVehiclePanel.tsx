"use client";

import Autocomplete, { createFilterOptions } from "@mui/material/Autocomplete";
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
import type { ConnectorStandard, EvVehicleSpec } from "@openmapx/core";
import { useDirectionsStore, useSettingsStore } from "@openmapx/core";
import { COMMON_EV_NETWORKS, listVehicles } from "@openmapx/ev-charge-planner";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { CUSTOM_VEHICLE_ID } from "@/lib/buildEvDirectionsRequest";
import { TEAL } from "@/lib/theme";

const HOME_CURRENCIES = ["EUR", "USD", "GBP", "CHF"];

interface VehicleOption {
  id: string;
  label: string;
}

const VEHICLE_OPTIONS = listVehicles();

// Deliberately uncapped. A limit truncates the *unfiltered* list too, and with
// 51 Audis alphabetically first, any screenful-sized cap makes the picker look
// like it only stocks Audi. Typing narrows it immediately, so the full list is
// only ever rendered while the user is browsing.
const filterVehicleOptions = createFilterOptions<VehicleOption>();

const CONNECTOR_OPTIONS: ConnectorStandard[] = [
  "ccs2",
  "ccs1",
  "chademo",
  "type2",
  "type1",
  "tesla_ccs",
  "nacs",
  "gbt_ac",
  "gbt_dc",
  "type3",
];

/** Sensible European default so a half-filled custom form still yields a usable spec. */
const DEFAULT_CUSTOM_CONNECTORS: ConnectorStandard[] = ["ccs2", "type2"];

/** Quiet period before a custom-vehicle edit reaches the store and triggers a re-plan. */
const COMMIT_DEBOUNCE_MS = 500;

interface CustomVehicleDraft {
  battery: string;
  consumption: string;
  maxDc: string;
  maxAc: string;
  connectors: ConnectorStandard[];
}

/** Null until battery, consumption and DC power are all positive — a partial form must not be sent. */
function draftToSpec(draft: CustomVehicleDraft): EvVehicleSpec | null {
  const batteryKwh = Number(draft.battery);
  const baseWhPerKm = Number(draft.consumption);
  const maxDcKw = Number(draft.maxDc);
  const maxAcKw = Number(draft.maxAc);
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  if (!positive(batteryKwh) || !positive(baseWhPerKm) || !positive(maxDcKw)) return null;
  if (draft.connectors.length === 0) return null;
  return {
    batteryKwh,
    baseWhPerKm,
    massTonnes: 2,
    maxDcKw,
    maxAcKw: Number.isFinite(maxAcKw) && maxAcKw > 0 ? maxAcKw : 0,
    vehicleTaperSocPct: 80,
    connectors: draft.connectors,
  };
}

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
  const evCustomVehicle = useSettingsStore((s) => s.evCustomVehicle);
  const setEvCustomVehicle = useSettingsStore((s) => s.setEvCustomVehicle);

  const options = useMemo<VehicleOption[]>(
    () => [{ id: CUSTOM_VEHICLE_ID, label: t("customVehicle") }, ...VEHICLE_OPTIONS],
    [t],
  );

  const isCustomVehicle = evVehicleId === CUSTOM_VEHICLE_ID;
  const [customDraft, setCustomDraft] = useState<CustomVehicleDraft>(() => ({
    battery: evCustomVehicle ? String(evCustomVehicle.batteryKwh) : "",
    consumption: evCustomVehicle ? String(evCustomVehicle.baseWhPerKm) : "",
    maxDc: evCustomVehicle ? String(evCustomVehicle.maxDcKw) : "",
    maxAc: evCustomVehicle ? String(evCustomVehicle.maxAcKw) : "",
    connectors: evCustomVehicle?.connectors ?? DEFAULT_CUSTOM_CONNECTORS,
  }));

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(commitTimer.current ?? undefined), []);

  // The store write drives both EV-plan request memos, and a plan is a real
  // server-side route + corridor-charger + matrix computation. Writing on every
  // keystroke would plan for "7" and then "77" while the user types battery
  // size, so the spec only reaches the store once typing pauses.
  const updateCustomDraft = (patch: Partial<CustomVehicleDraft>) => {
    const next = { ...customDraft, ...patch };
    setCustomDraft(next);
    clearTimeout(commitTimer.current ?? undefined);
    commitTimer.current = setTimeout(
      () => setEvCustomVehicle(draftToSpec(next)),
      COMMIT_DEBOUNCE_MS,
    );
  };

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Autocomplete
        size="small"
        options={options}
        filterOptions={filterVehicleOptions}
        getOptionLabel={(o) => o.label}
        isOptionEqualToValue={(o, v) => o.id === v.id}
        value={options.find((o) => o.id === evVehicleId) ?? null}
        onChange={(_event, option) => setEvVehicleId(option?.id ?? null)}
        // Keyed by id, not by the default label key: 28 dataset entries share a
        // display name (a base record plus its identically-named trim).
        renderOption={({ key: _key, ...props }, option) => (
          <li {...props} key={option.id}>
            {option.label}
          </li>
        )}
        renderInput={(params) => (
          <TextField {...params} label={t("vehicle")} variant="outlined" size="small" />
        )}
      />

      {isCustomVehicle && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Box sx={{ display: "flex", gap: 1.5 }}>
            <TextField
              size="small"
              type="number"
              label={t("customBattery")}
              value={customDraft.battery}
              onChange={(e) => updateCustomDraft({ battery: e.target.value })}
              slotProps={{ htmlInput: { min: 0, step: 0.1 } }}
              fullWidth
            />
            <TextField
              size="small"
              type="number"
              label={t("customConsumption")}
              value={customDraft.consumption}
              onChange={(e) => updateCustomDraft({ consumption: e.target.value })}
              slotProps={{ htmlInput: { min: 0, step: 1 } }}
              fullWidth
            />
          </Box>
          <Box sx={{ display: "flex", gap: 1.5 }}>
            <TextField
              size="small"
              type="number"
              label={t("customMaxDc")}
              value={customDraft.maxDc}
              onChange={(e) => updateCustomDraft({ maxDc: e.target.value })}
              slotProps={{ htmlInput: { min: 0, step: 1 } }}
              fullWidth
            />
            <TextField
              size="small"
              type="number"
              label={t("customMaxAc")}
              value={customDraft.maxAc}
              onChange={(e) => updateCustomDraft({ maxAc: e.target.value })}
              slotProps={{ htmlInput: { min: 0, step: 0.1 } }}
              fullWidth
            />
          </Box>
          <Autocomplete
            multiple
            size="small"
            options={CONNECTOR_OPTIONS}
            getOptionLabel={(c) => t(`connector.${c}`)}
            value={customDraft.connectors}
            onChange={(_event, value) => updateCustomDraft({ connectors: value })}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t("customConnectors")}
                variant="outlined"
                size="small"
              />
            )}
          />
        </Box>
      )}

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

      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={COMMON_EV_NETWORKS}
        value={evPreferredNetworks}
        onChange={(_event, newValue) => setEvPreferredNetworks(newValue as string[])}
        renderInput={(params) => (
          <TextField {...params} label={t("preferredNetworks")} variant="outlined" size="small" />
        )}
      />

      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={COMMON_EV_NETWORKS}
        value={evAvoidedNetworks}
        onChange={(_event, newValue) => setEvAvoidedNetworks(newValue as string[])}
        renderInput={(params) => (
          <TextField {...params} label={t("avoidedNetworks")} variant="outlined" size="small" />
        )}
      />

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
