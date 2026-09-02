"use client";

import CloseIcon from "@mui/icons-material/Close";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type {
  ConnectorStandard,
  VehicleDraft,
  VehicleKind,
  VehiclePowertrain,
} from "@openmapx/core";
import {
  MAX_VEHICLES_PER_USER,
  normalizeEvSpec,
  useCreateVehicle,
  useDeleteVehicle,
  useUpdateVehicle,
  useVehicles,
  VEHICLE_KINDS,
  VEHICLE_POWERTRAINS,
} from "@openmapx/core";
import { getVehiclePreset, listVehicles } from "@openmapx/ev-charge-planner";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
import { Section } from "./settingsPrimitives";

const EV_PRESETS = listVehicles();
const DEFAULT_CONNECTORS: ConnectorStandard[] = ["ccs2", "type2"];
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

function isElectric(powertrain: VehiclePowertrain): boolean {
  return powertrain === "electric" || powertrain === "plugin_hybrid";
}

/** `kindCar`, `powertrainPluginHybrid` — the locale keys are camel-cased suffixes. */
function labelKey(prefix: string, value: string): string {
  const camel = value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${prefix}${camel}`;
}

interface Draft {
  id: string | null;
  name: string;
  kind: VehicleKind;
  powertrain: VehiclePowertrain;
  presetId: string | null;
  battery: string;
  consumption: string;
  maxDc: string;
  maxAc: string;
  connectors: ConnectorStandard[];
  fuel: string;
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    kind: "car",
    powertrain: "petrol",
    presetId: null,
    battery: "",
    consumption: "",
    maxDc: "",
    maxAc: "",
    connectors: DEFAULT_CONNECTORS,
    fuel: "",
  };
}

/** Null until the draft would pass the shared normalizer, which gates the Save button. */
function draftToVehicle(draft: Draft): VehicleDraft | null {
  const name = draft.name.trim();
  if (name === "") return null;

  if (isElectric(draft.powertrain)) {
    // Same validator the server and the local store run, so the Save button is
    // disabled for exactly the specs a write would have rejected.
    const ev = normalizeEvSpec({
      batteryKwh: Number(draft.battery),
      baseWhPerKm: Number(draft.consumption),
      massTonnes: 2,
      maxDcKw: Number(draft.maxDc),
      maxAcKw: Number(draft.maxAc),
      vehicleTaperSocPct: 80,
      connectors: draft.connectors,
    });
    if (!ev) return null;
    return {
      name,
      kind: draft.kind,
      powertrain: draft.powertrain,
      isDefault: false,
      presetId: draft.presetId,
      ev,
      fuelConsumptionLPer100Km: null,
    };
  }

  const fuel = Number(draft.fuel);
  return {
    name,
    kind: draft.kind,
    powertrain: draft.powertrain,
    isDefault: false,
    presetId: draft.presetId,
    ev: null,
    fuelConsumptionLPer100Km:
      draft.kind === "bicycle" || draft.fuel === "" || !Number.isFinite(fuel) || fuel <= 0
        ? null
        : fuel,
  };
}

export function VehiclesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("vehicles");
  const tc = useTranslations("common");
  // Connector labels already exist under the EV namespace; charge planning
  // filters on these, so the garage has to be able to set them.
  const tEv = useTranslations("directions.ev");
  const fullScreen = useFullScreenOnMobile();
  const { data: vehicles } = useVehicles();
  const create = useCreateVehicle();
  const update = useUpdateVehicle();
  const remove = useDeleteVehicle();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const rows = vehicles ?? [];
  const atCap = rows.length >= MAX_VEHICLES_PER_USER;
  const payload = draft ? draftToVehicle(draft) : null;

  const applyPreset = (presetId: string | null) => {
    if (!draft) return;
    const spec = presetId ? getVehiclePreset(presetId) : null;
    setDraft({
      ...draft,
      presetId,
      ...(spec
        ? {
            battery: String(spec.batteryKwh),
            consumption: String(spec.baseWhPerKm),
            maxDc: String(spec.maxDcKw),
            maxAc: String(spec.maxAcKw),
            connectors: spec.connectors,
          }
        : {}),
    });
  };

  const handleSave = () => {
    if (!draft || !payload) return;
    if (draft.id) update.mutate({ id: draft.id, ...payload });
    else create.mutate(payload);
    setDraft(null);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {t("title")}
        <IconButton onClick={onClose} aria-label={tc("close")} edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {rows.length === 0 && !draft && (
          <Typography variant="body2" color="text.secondary">
            {t("empty")}
          </Typography>
        )}

        {rows.map((vehicle) => (
          <Box key={vehicle.id} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
            <Radio
              checked={vehicle.isDefault}
              onChange={() => update.mutate({ id: vehicle.id, isDefault: true })}
              slotProps={{ input: { "aria-label": t("makeDefault") } }}
            />
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
              {vehicle.name}
            </Typography>
            <Button
              size="small"
              onClick={() =>
                setDraft({
                  id: vehicle.id,
                  name: vehicle.name,
                  kind: vehicle.kind,
                  powertrain: vehicle.powertrain,
                  presetId: vehicle.presetId,
                  battery: vehicle.ev ? String(vehicle.ev.batteryKwh) : "",
                  consumption: vehicle.ev ? String(vehicle.ev.baseWhPerKm) : "",
                  maxDc: vehicle.ev ? String(vehicle.ev.maxDcKw) : "",
                  maxAc: vehicle.ev ? String(vehicle.ev.maxAcKw) : "",
                  connectors: vehicle.ev?.connectors ?? DEFAULT_CONNECTORS,
                  fuel:
                    vehicle.fuelConsumptionLPer100Km === null
                      ? ""
                      : String(vehicle.fuelConsumptionLPer100Km),
                })
              }
            >
              {t("edit")}
            </Button>
            <Button size="small" color="error" onClick={() => setConfirmingDelete(vehicle.id)}>
              {t("delete")}
            </Button>
          </Box>
        ))}

        {confirmingDelete && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="body2" color="error">
              {t("deleteWarning")}
            </Typography>
            <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
              <Button
                size="small"
                color="error"
                variant="contained"
                onClick={() => {
                  remove.mutate(confirmingDelete);
                  setConfirmingDelete(null);
                }}
              >
                {t("delete")}
              </Button>
              <Button size="small" onClick={() => setConfirmingDelete(null)}>
                {t("cancel")}
              </Button>
            </Box>
          </Box>
        )}

        {atCap ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            {t("limitReached", { count: MAX_VEHICLES_PER_USER })}
          </Typography>
        ) : (
          !draft && (
            <Button sx={{ mt: 1 }} onClick={() => setDraft(emptyDraft())}>
              {t("add")}
            </Button>
          )
        )}

        {draft && (
          <Section title={draft.id ? t("edit") : t("add")}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              <TextField
                size="small"
                label={t("name")}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                fullWidth
              />
              <Select
                size="small"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as VehicleKind })}
                inputProps={{ "aria-label": t("kind") }}
              >
                {VEHICLE_KINDS.map((kind) => (
                  <MenuItem key={kind} value={kind}>
                    {t(labelKey("kind", kind))}
                  </MenuItem>
                ))}
              </Select>
              <Select
                size="small"
                value={draft.powertrain}
                onChange={(e) =>
                  setDraft({ ...draft, powertrain: e.target.value as VehiclePowertrain })
                }
                inputProps={{ "aria-label": t("powertrain") }}
              >
                {VEHICLE_POWERTRAINS.map((powertrain) => (
                  <MenuItem key={powertrain} value={powertrain}>
                    {t(labelKey("powertrain", powertrain))}
                  </MenuItem>
                ))}
              </Select>

              {isElectric(draft.powertrain) ? (
                <>
                  <Autocomplete
                    size="small"
                    options={EV_PRESETS}
                    getOptionLabel={(o) => o.label}
                    getOptionKey={(o) => o.id}
                    groupBy={(o) => o.make}
                    value={EV_PRESETS.find((o) => o.id === draft.presetId) ?? null}
                    onChange={(_event, option) => applyPreset(option?.id ?? null)}
                    renderInput={(params) => (
                      <TextField {...params} size="small" label={t("preset")} />
                    )}
                  />
                  <Box sx={{ display: "flex", gap: 1.5 }}>
                    <TextField
                      size="small"
                      type="number"
                      label={t("battery")}
                      value={draft.battery}
                      onChange={(e) => setDraft({ ...draft, battery: e.target.value })}
                      fullWidth
                    />
                    <TextField
                      size="small"
                      type="number"
                      label={t("consumption")}
                      value={draft.consumption}
                      onChange={(e) => setDraft({ ...draft, consumption: e.target.value })}
                      fullWidth
                    />
                  </Box>
                  <Box sx={{ display: "flex", gap: 1.5 }}>
                    <TextField
                      size="small"
                      type="number"
                      label={t("maxDc")}
                      value={draft.maxDc}
                      onChange={(e) => setDraft({ ...draft, maxDc: e.target.value })}
                      fullWidth
                    />
                    <TextField
                      size="small"
                      type="number"
                      label={t("maxAc")}
                      value={draft.maxAc}
                      onChange={(e) => setDraft({ ...draft, maxAc: e.target.value })}
                      fullWidth
                    />
                  </Box>
                  <Autocomplete
                    multiple
                    size="small"
                    options={CONNECTOR_OPTIONS}
                    getOptionLabel={(c) => tEv(`connector.${c}`)}
                    value={draft.connectors}
                    onChange={(_event, value) =>
                      setDraft({ ...draft, connectors: value as ConnectorStandard[] })
                    }
                    renderInput={(params) => (
                      <TextField {...params} size="small" label={t("connectors")} />
                    )}
                  />
                </>
              ) : (
                draft.kind !== "bicycle" && (
                  <TextField
                    size="small"
                    type="number"
                    label={t("fuelConsumption")}
                    value={draft.fuel}
                    onChange={(e) => setDraft({ ...draft, fuel: e.target.value })}
                    fullWidth
                  />
                )
              )}

              <Box sx={{ display: "flex", gap: 1 }}>
                <Button variant="contained" disabled={payload === null} onClick={handleSave}>
                  {t("save")}
                </Button>
                <Button onClick={() => setDraft(null)}>{t("cancel")}</Button>
              </Box>
            </Box>
          </Section>
        )}
      </DialogContent>
    </Dialog>
  );
}
