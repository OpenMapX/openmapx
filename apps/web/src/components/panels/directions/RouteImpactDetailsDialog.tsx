"use client";

import CloseIcon from "@mui/icons-material/Close";
import EnergySavingsLeafIcon from "@mui/icons-material/EnergySavingsLeaf";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { formatMeasurementDistance, type RouteImpact, useSettingsStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { formatCo2Emission } from "@/lib/formatCo2";
import { RouteImpactProvenance } from "./RouteImpactProvenance";

export interface RouteImpactAssumptions {
  occupancy?: number;
  fuelPricePerLiter?: number | null;
  electricityPricePerKwh?: number | null;
  vehicleId?: string | null;
}

export interface RouteImpactDetailsDialogProps {
  open: boolean;
  onClose: () => void;
  impact: RouteImpact;
  vehicles?: Array<{ id: string; name: string }>;
  onUpdateAssumptions?: (assumptions: RouteImpactAssumptions) => void;
}

export function formatEnergyConsumed(
  energy: RouteImpact["energy"],
  powertrain: string,
  locale: string,
  petrolLabel = "Petrol",
  electricityLabel = "Electricity",
  dieselLabel = "Diesel",
): string {
  const parts: string[] = [];
  const numFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (energy.fuelLiters !== null && energy.fuelLiters > 0) {
    const fuelType = powertrain.toLowerCase() === "diesel" ? dieselLabel : petrolLabel;
    parts.push(`${numFormatter.format(energy.fuelLiters)} L ${fuelType}`);
  }
  if (energy.electricityKwh !== null && energy.electricityKwh > 0) {
    parts.push(`${numFormatter.format(energy.electricityKwh)} kWh ${electricityLabel}`);
  }
  if (parts.length === 0) {
    if (energy.fuelLiters === 0 || energy.electricityKwh === 0) {
      return "0";
    }
    return "—";
  }
  return parts.join(" + ");
}

export function RouteImpactDetailsDialog({
  open,
  onClose,
  impact,
  vehicles,
  onUpdateAssumptions,
}: RouteImpactDetailsDialogProps) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tv = useTranslations("vehicles");
  const locale = useLocale();
  const units = useSettingsStore((state) => state.units);

  const petrolLabel = tv("powertrainPetrol");
  const dieselLabel = tv("powertrainDiesel");
  const electricityLabel = tv("powertrainElectric");

  const [tab, setTab] = useState(0);
  const [occupancy, setOccupancy] = useState(impact.occupancy);
  const [fuelPrice, setFuelPrice] = useState<number | null>(null);
  const [electricityPrice, setElectricityPrice] = useState<number | null>(null);
  const [vehicleId, setVehicleId] = useState(impact.vehicleId ?? "");

  useEffect(() => {
    setOccupancy(impact.occupancy);
    setVehicleId(impact.vehicleId ?? "");
  }, [impact.occupancy, impact.vehicleId]);

  const currencyFormatter = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: impact.cost.currency,
      });
    } catch {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "EUR",
      });
    }
  }, [locale, impact.cost.currency]);

  const isElectricTailpipeZero =
    impact.vehiclePowertrain.toLowerCase() === "electric" ||
    (impact.emissions.tailpipeGrams === 0 && impact.energy.electricityKwh !== null);

  const vehicleFallbackLabel = t("ev.vehicle");

  const availableVehicles = useMemo(() => {
    if (vehicles && vehicles.length > 0) return vehicles;
    return [
      { id: impact.vehicleId ?? "default", name: impact.vehicleName || vehicleFallbackLabel },
    ];
  }, [vehicles, impact.vehicleId, impact.vehicleName, vehicleFallbackLabel]);

  const effectiveVehicleId = availableVehicles.some((v) => v.id === vehicleId)
    ? vehicleId
    : (availableVehicles[0]?.id ?? "");

  const pricePlaceholderFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [locale],
  );

  const defaultFuelPricePlaceholder = useMemo(() => {
    if (impact.energy.fuelLiters && impact.energy.fuelLiters > 0) {
      return pricePlaceholderFormatter.format(impact.cost.energyCost / impact.energy.fuelLiters);
    }
    return undefined;
  }, [impact.energy.fuelLiters, impact.cost.energyCost, pricePlaceholderFormatter]);

  const defaultElecPricePlaceholder = useMemo(() => {
    if (impact.energy.electricityKwh && impact.energy.electricityKwh > 0) {
      return pricePlaceholderFormatter.format(
        impact.cost.energyCost / impact.energy.electricityKwh,
      );
    }
    return undefined;
  }, [impact.energy.electricityKwh, impact.cost.energyCost, pricePlaceholderFormatter]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="route-impact-dialog-title"
      data-testid="route-impact-details-dialog"
    >
      <DialogTitle
        id="route-impact-dialog-title"
        sx={{
          m: 0,
          p: 2,
          pr: 6,
          display: "flex",
          flexDirection: "column",
          gap: 0.5,
        }}
      >
        <Typography variant="h6" component="div" sx={{ fontWeight: 600 }}>
          {t("impactDetailsTitle")}
        </Typography>
        {impact.vehicleName && (
          <Typography variant="body2" color="text.secondary" data-testid="dialog-vehicle-name">
            {impact.vehicleName}
          </Typography>
        )}
        <IconButton
          aria-label={tc("close")}
          onClick={onClose}
          data-testid="dialog-close-button"
          sx={{
            position: "absolute",
            right: 8,
            top: 8,
            color: (theme) => theme.palette.grey[500],
          }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <Tabs
        value={tab}
        onChange={(_, newValue) => setTab(newValue)}
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: "divider", px: 2 }}
      >
        <Tab label={t("tabBreakdown")} data-testid="tab-breakdown" />
        <Tab label={t("tabAssumptions")} data-testid="tab-assumptions" />
        <Tab label={t("tabProvenance")} data-testid="tab-provenance" />
      </Tabs>

      <DialogContent sx={{ p: 2.5 }}>
        {tab === 0 && (
          <Box
            sx={{ display: "flex", flexDirection: "column" }}
            data-testid="breakdown-tab-content"
          >
            {impact.comparison && (
              <Box sx={{ mb: 2 }}>
                {impact.comparison.isLowestEmissions && (
                  <Chip
                    size="small"
                    icon={<EnergySavingsLeafIcon sx={{ fontSize: "14px !important" }} />}
                    label={t("ecoChoice")}
                    color="success"
                    data-testid="dialog-eco-choice-chip"
                    sx={{
                      height: 24,
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      mb: 1,
                      "& .MuiChip-label": { px: 0.75 },
                      "& .MuiChip-icon": { ml: 0.5, mr: -0.25 },
                    }}
                  />
                )}
                {impact.comparison.reason && (
                  <Alert
                    severity={impact.comparison.isLowestEmissions ? "success" : "info"}
                    data-testid="comparison-explanation-banner"
                    sx={{ py: 0.5 }}
                  >
                    {impact.comparison.reason.kind === "shorter"
                      ? t("savesDistance", {
                          dist: formatMeasurementDistance(
                            impact.comparison.reason.distanceMeters,
                            units,
                          ),
                        })
                      : impact.comparison.reason.kind === "less_climbing"
                        ? t("avoidsClimb", {
                            climb: `${Math.round(impact.comparison.reason.climbMeters)} m`,
                          })
                        : impact.comparison.reason.kind === "electric_efficiency"
                          ? t("electricEfficiency")
                          : t("avoidsConsumption")}
                  </Alert>
                )}
              </Box>
            )}

            <Box sx={{ mb: 2.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                {t("emissionsSection")}
              </Typography>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  p: 1.5,
                  borderRadius: 1.5,
                  bgcolor: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255, 255, 255, 0.05)"
                      : "rgba(0, 0, 0, 0.03)",
                }}
              >
                <Box
                  sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {t("wellToWheelTotal")}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 700 }}
                    data-testid="wtw-total-emissions"
                  >
                    {formatCo2Emission(impact.emissions.totalGrams, locale) ?? "0 g CO2"}
                  </Typography>
                </Box>
                <Divider />
                <Box
                  sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {t("operationalTailpipe")}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: 500 }}
                    data-testid="tailpipe-emissions"
                  >
                    {isElectricTailpipeZero
                      ? t("zeroDirectEmissions")
                      : (formatCo2Emission(impact.emissions.tailpipeGrams, locale) ?? "0 g CO2")}
                  </Typography>
                </Box>
                <Box
                  sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {t("upstreamEnergy")}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: 500 }}
                    data-testid="upstream-emissions"
                  >
                    {formatCo2Emission(impact.emissions.upstreamGrams, locale) ?? "0 g CO2"}
                  </Typography>
                </Box>
              </Box>
            </Box>

            <Box sx={{ mb: 2.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                {t("energySection")}
              </Typography>
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1.5,
                  bgcolor: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255, 255, 255, 0.05)"
                      : "rgba(0, 0, 0, 0.03)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  {t("energyConsumed")}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 600 }}
                  data-testid="energy-consumed-value"
                >
                  {formatEnergyConsumed(
                    impact.energy,
                    impact.vehiclePowertrain,
                    locale,
                    petrolLabel,
                    electricityLabel,
                    dieselLabel,
                  )}
                </Typography>
              </Box>
            </Box>

            <Box sx={{ mb: 2.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                {t("costSection")}
              </Typography>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  p: 1.5,
                  borderRadius: 1.5,
                  bgcolor: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255, 255, 255, 0.05)"
                      : "rgba(0, 0, 0, 0.03)",
                }}
              >
                {impact.cost.costType === "road" && (
                  <>
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        {impact.energy.electricityKwh !== null && impact.energy.fuelLiters === null
                          ? t("electricityCost")
                          : t("fuelCost")}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{ fontWeight: 500 }}
                        data-testid="energy-cost-value"
                      >
                        {currencyFormatter.format(impact.cost.energyCost)}
                      </Typography>
                    </Box>
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        {t("tolls")}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{ fontWeight: 500 }}
                        data-testid="tolls-cost-value"
                      >
                        {impact.cost.tollStatus === "unknown"
                          ? t("tollCostUnknown")
                          : impact.cost.tollStatus === "no_tolls"
                            ? t("noTolls")
                            : impact.cost.tollStatus === "tolls_unknown"
                              ? t("tollsUnknown")
                              : impact.cost.tollCost !== null
                                ? currencyFormatter.format(impact.cost.tollCost)
                                : t("tollsIncluded")}
                      </Typography>
                    </Box>
                  </>
                )}
                {impact.cost.costType === "transit" && (
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      {t("transitFare")}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ fontWeight: 500 }}
                      data-testid="transit-fare-value"
                    >
                      {impact.cost.transitFare === null
                        ? t("fareUnavailable")
                        : currencyFormatter.format(impact.cost.transitFare)}
                    </Typography>
                  </Box>
                )}
                <Divider />
                <Box
                  sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {impact.cost.costCompleteness === "complete"
                      ? t("totalCost")
                      : t("knownCostSubtotal")}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 700 }}
                    data-testid="total-cost-value"
                  >
                    {impact.cost.totalCost !== null
                      ? currencyFormatter.format(impact.cost.totalCost)
                      : impact.cost.knownCost !== null
                        ? currencyFormatter.format(impact.cost.knownCost)
                        : t("costUnavailable")}
                  </Typography>
                </Box>
              </Box>
            </Box>

            {impact.occupancy > 1 && (
              <Box sx={{ mb: 1 }} data-testid="per-person-section">
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                  {t("perPerson")} ({t("occupancyCount", { count: impact.occupancy })})
                </Typography>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 1.5,
                    bgcolor: (theme) =>
                      theme.palette.mode === "dark"
                        ? "rgba(255, 255, 255, 0.05)"
                        : "rgba(0, 0, 0, 0.03)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      {t("wellToWheelTotal")}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 600 }}
                      data-testid="per-person-emissions"
                    >
                      {formatCo2Emission(
                        impact.perPerson?.emissionsGrams ??
                          impact.emissions.totalGrams / impact.occupancy,
                        locale,
                      ) ?? "—"}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="caption" color="text.secondary">
                      {impact.cost.costCompleteness === "complete"
                        ? t("totalCost")
                        : t("knownCostSubtotal")}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 600 }}
                      data-testid="per-person-cost"
                    >
                      {impact.perPerson?.knownCost !== null &&
                      impact.perPerson?.knownCost !== undefined
                        ? currencyFormatter.format(impact.perPerson.knownCost)
                        : "—"}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            )}
          </Box>
        )}

        {tab === 1 && (
          <Box
            sx={{ display: "flex", flexDirection: "column", gap: 3, pt: 1 }}
            data-testid="assumptions-tab-content"
          >
            <Box>
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  mb: 1,
                }}
              >
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  {t("occupancy")}
                </Typography>
                <Chip
                  size="small"
                  label={t("occupancyCount", { count: occupancy })}
                  data-testid="occupancy-count-badge"
                />
              </Box>
              <Slider
                value={occupancy}
                min={1}
                max={5}
                step={1}
                marks
                valueLabelDisplay="auto"
                aria-label={t("occupancy")}
                data-testid="occupancy-slider"
                onChange={(_, val) => {
                  const n = Array.isArray(val) ? val[0] : val;
                  setOccupancy(n);
                  onUpdateAssumptions?.({ occupancy: n });
                }}
              />
            </Box>

            {impact.energy.fuelLiters !== null && (
              <Box>
                <TextField
                  label={t("fuelPricePerLiter", { currency: impact.cost.currency })}
                  type="number"
                  fullWidth
                  size="small"
                  slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
                  value={fuelPrice ?? ""}
                  placeholder={defaultFuelPricePlaceholder}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    const val =
                      e.target.value !== "" && Number.isFinite(parsed) && parsed > 0
                        ? parsed
                        : null;
                    setFuelPrice(val);
                    onUpdateAssumptions?.({ fuelPricePerLiter: val });
                  }}
                  data-testid="fuel-price-input"
                />
              </Box>
            )}

            {impact.energy.electricityKwh !== null && (
              <Box>
                <TextField
                  label={t("electricityPricePerKwh", { currency: impact.cost.currency })}
                  type="number"
                  fullWidth
                  size="small"
                  slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
                  value={electricityPrice ?? ""}
                  placeholder={defaultElecPricePlaceholder}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    const val =
                      e.target.value !== "" && Number.isFinite(parsed) && parsed > 0
                        ? parsed
                        : null;
                    setElectricityPrice(val);
                    onUpdateAssumptions?.({ electricityPricePerKwh: val });
                  }}
                  data-testid="electricity-price-input"
                />
              </Box>
            )}

            {onUpdateAssumptions && (
              <Box>
                <FormControl fullWidth size="small">
                  <InputLabel id="impact-vehicle-select-label">
                    {impact.vehicleName || vehicleFallbackLabel}
                  </InputLabel>
                  <Select
                    labelId="impact-vehicle-select-label"
                    id="impact-vehicle-select"
                    value={effectiveVehicleId}
                    label={impact.vehicleName || vehicleFallbackLabel}
                    onChange={(e) => {
                      const val = e.target.value;
                      setVehicleId(val);
                      onUpdateAssumptions?.({ vehicleId: val });
                    }}
                    data-testid="vehicle-select"
                  >
                    {availableVehicles.map((v) => (
                      <MenuItem key={v.id} value={v.id}>
                        {v.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            )}
          </Box>
        )}

        {tab === 2 && <RouteImpactProvenance impact={impact} />}
      </DialogContent>
    </Dialog>
  );
}
