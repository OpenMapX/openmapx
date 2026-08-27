"use client";

import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import {
  TRANSIT_ACCESS_OPTIONS,
  TRANSIT_PREFER_OPTIONS,
  type TransitAccessMode,
  type TransitRoutePreference,
  useDirectionsStore,
  useRouteInGermany,
  useSettingsStore,
  useTransitPlanningCapabilities,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { BRAND } from "@/lib/theme";

function ColumnHeading({ label }: { label: string }) {
  return (
    <Typography
      variant="caption"
      sx={{
        fontWeight: 600,
        color: "text.secondary",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {label}
    </Typography>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Box
      onClick={() => onChange(!checked)}
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onChange(!checked);
        }
      }}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.5,
        cursor: "pointer",
        "&:hover": { color: BRAND },
      }}
    >
      {checked ? (
        <CheckBoxIcon sx={{ fontSize: 20, color: BRAND }} />
      ) : (
        <CheckBoxOutlineBlankIcon sx={{ fontSize: 20, color: "text.secondary" }} />
      )}
      <Typography variant="body2">{label}</Typography>
    </Box>
  );
}

function RadioRow({
  label,
  selected,
  onSelect,
  disabled = false,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <Box
      onClick={disabled ? undefined : onSelect}
      role="radio"
      aria-checked={selected}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onKeyDown={(event) => {
        if (!disabled && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          onSelect();
        }
      }}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        "&:hover": { color: BRAND },
      }}
    >
      {selected ? (
        <RadioButtonCheckedIcon sx={{ fontSize: 20, color: BRAND }} />
      ) : (
        <RadioButtonUncheckedIcon sx={{ fontSize: 20, color: "text.secondary" }} />
      )}
      <Typography variant="body2">{label}</Typography>
    </Box>
  );
}

const PREFER_LABEL_KEYS = {
  bus: "bus",
  subway: "subway",
  train: "train",
  tram: "tramLightRail",
} as const;

const ROUTE_PREFERENCE_KEYS: { value: TransitRoutePreference; labelKey: string }[] = [
  { value: "best", labelKey: "bestRoute" },
  { value: "fewerTransfers", labelKey: "fewerTransfers" },
  { value: "lessWalking", labelKey: "lessWalking" },
];

const ACCESS_MODE_LABEL_KEYS: Record<TransitAccessMode, string> = {
  walk: "accessWalk",
  bike: "accessOwnBike",
  bike_share: "accessBikeShare",
  scooter_share: "accessScooterShare",
  car_share: "accessCarShare",
  car: "accessCar",
};

function TransitRouteOptions() {
  const t = useTranslations("directions");
  const origin = useDirectionsStore((s) => s.waypoints[0]?.coords ?? null);
  const destination = useDirectionsStore((s) => s.waypoints.at(-1)?.coords ?? null);
  const transitPreferredModes = useDirectionsStore((s) => s.transitPreferredModes);
  const toggleTransitPreferredMode = useDirectionsStore((s) => s.toggleTransitPreferredMode);
  const transitRoutePreference = useDirectionsStore((s) => s.transitRoutePreference);
  const setTransitRoutePreference = useDirectionsStore((s) => s.setTransitRoutePreference);
  const transitAccessMode = useDirectionsStore((s) => s.transitAccessMode);
  const setTransitAccessMode = useDirectionsStore((s) => s.setTransitAccessMode);
  const wheelchairRequired = useDirectionsStore((s) => s.wheelchairRequired);
  const setWheelchairRequired = useDirectionsStore((s) => s.setWheelchairRequired);
  const maxTransfers = useDirectionsStore((s) => s.maxTransfers);
  const setMaxTransfers = useDirectionsStore((s) => s.setMaxTransfers);
  const transferBuffer = useDirectionsStore((s) => s.transferBuffer);
  const setTransferBuffer = useDirectionsStore((s) => s.setTransferBuffer);
  const requireBikeTransport = useDirectionsStore((s) => s.requireBikeTransport);
  const setRequireBikeTransport = useDirectionsStore((s) => s.setRequireBikeTransport);
  const bikeHillPreference = useDirectionsStore((s) => s.bikeHillPreference);
  const setBikeHillPreference = useDirectionsStore((s) => s.setBikeHillPreference);
  const deutschlandticketOnly = useDirectionsStore((s) => s.deutschlandticketOnly);
  const setDeutschlandticketOnly = useDirectionsStore((s) => s.setDeutschlandticketOnly);
  const { data: planningCapabilities } = useTransitPlanningCapabilities();
  const availableRentalFactors = new Set(
    planningCapabilities?.providers.flatMap(
      (provider) => provider.metadata?.rentalFormFactors ?? [],
    ) ?? [],
  );

  // The Deutschlandticket is a German nationwide pass, so the option only makes
  // sense — and is only shown — when both endpoints resolve to Germany.
  const { bothInGermany } = useRouteInGermany(origin, destination);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", gap: 4 }}>
        <Box sx={{ flex: 1 }}>
          <ColumnHeading label={t("prefer")} />
          {TRANSIT_PREFER_OPTIONS.map((key) => (
            <CheckRow
              key={key}
              label={t(PREFER_LABEL_KEYS[key])}
              checked={transitPreferredModes.includes(key)}
              onChange={() => toggleTransitPreferredMode(key)}
            />
          ))}
        </Box>
        <Box sx={{ flex: 1 }}>
          <ColumnHeading label={t("routes")} />
          {ROUTE_PREFERENCE_KEYS.map(({ value, labelKey }) => (
            <RadioRow
              key={value}
              label={t(labelKey)}
              selected={transitRoutePreference === value}
              onSelect={() => setTransitRoutePreference(value)}
            />
          ))}
        </Box>
      </Box>
      <Box>
        <Divider sx={{ mb: 1, mx: -2 }} />
        <CheckRow
          label={t("wheelchairRequired")}
          checked={wheelchairRequired}
          onChange={setWheelchairRequired}
        />
        <Box sx={{ display: "flex", gap: 1.5, mt: 1, flexWrap: "wrap" }}>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel id="max-transfers-label">{t("maximumTransfers")}</InputLabel>
            <Select
              labelId="max-transfers-label"
              label={t("maximumTransfers")}
              value={maxTransfers === null ? "" : String(maxTransfers)}
              onChange={(event) =>
                setMaxTransfers(event.target.value === "" ? null : Number(event.target.value))
              }
            >
              <MenuItem value="">{t("maximumTransfersAny")}</MenuItem>
              {[0, 1, 2, 3, 4].map((count) => (
                <MenuItem key={count} value={String(count)}>
                  {count}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 165 }}>
            <InputLabel id="transfer-buffer-label">{t("connectionBuffer")}</InputLabel>
            <Select
              labelId="transfer-buffer-label"
              label={t("connectionBuffer")}
              value={transferBuffer}
              onChange={(event) =>
                setTransferBuffer(event.target.value as "standard" | "relaxed" | "extra")
              }
            >
              <MenuItem value="standard">{t("bufferStandard")}</MenuItem>
              <MenuItem value="relaxed">{t("bufferRelaxed")}</MenuItem>
              <MenuItem value="extra">{t("bufferExtra")}</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Box>
      <Box>
        <Divider sx={{ mb: 1, mx: -2 }} />
        <ColumnHeading label={t("gettingThere")} />
        <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {TRANSIT_ACCESS_OPTIONS.map((m) => (
            <RadioRow
              key={m}
              label={t(ACCESS_MODE_LABEL_KEYS[m])}
              selected={transitAccessMode === m}
              onSelect={() => setTransitAccessMode(m)}
              disabled={
                m === "bike_share"
                  ? !["BICYCLE", "CARGO_BICYCLE"].some((factor) =>
                      availableRentalFactors.has(factor),
                    )
                  : m === "scooter_share"
                    ? !["SCOOTER_STANDING", "SCOOTER_SEATED", "MOPED"].some((factor) =>
                        availableRentalFactors.has(factor),
                      )
                    : m === "car_share"
                      ? !availableRentalFactors.has("CAR")
                      : false
              }
            />
          ))}
        </Box>
      </Box>
      {transitAccessMode === "bike" && (
        <Box>
          <CheckRow
            label={t("takeBikeAboard")}
            checked={requireBikeTransport}
            onChange={setRequireBikeTransport}
          />
          <FormControl size="small" sx={{ minWidth: 220, mt: 1 }}>
            <InputLabel id="bike-hills-label">{t("bikeHillPreference")}</InputLabel>
            <Select
              labelId="bike-hills-label"
              label={t("bikeHillPreference")}
              value={bikeHillPreference}
              onChange={(event) =>
                setBikeHillPreference(event.target.value as "default" | "avoid" | "strongly-avoid")
              }
            >
              <MenuItem value="default">{t("bikeHillsDefault")}</MenuItem>
              <MenuItem value="avoid">{t("bikeHillsAvoid")}</MenuItem>
              <MenuItem value="strongly-avoid">{t("bikeHillsStronglyAvoid")}</MenuItem>
            </Select>
          </FormControl>
        </Box>
      )}
      {bothInGermany && (
        <Box>
          <Divider sx={{ mb: 1, mx: -2 }} />
          <CheckRow
            label={t("deutschlandticketOnly")}
            checked={deutschlandticketOnly}
            onChange={setDeutschlandticketOnly}
          />
          <Typography variant="caption" sx={{ color: "text.secondary", pl: 3.5, display: "block" }}>
            {t("deutschlandticketHint")}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

export function RouteOptions() {
  const t = useTranslations("directions");
  const {
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    setAvoidHighways,
    setAvoidTolls,
    setAvoidFerries,
  } = useDirectionsStore();
  const units = useSettingsStore((s) => s.units);
  const setUnits = useSettingsStore((s) => s.setUnits);
  // Closure avoidance is a persisted, account-wide preference (kept in the
  // settings store so it's remembered), but surfaced here where users look for
  // routing options.
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const setAvoidIncidents = useSettingsStore((s) => s.setAvoidIncidents);

  // Highways and tolls only apply to driving; ferries can be avoided on foot or bike too.
  const isDriving = mode === "driving";
  const isTransit = mode === "transit";

  return (
    <Box sx={{ px: 2, pb: 1.5 }}>
      <Divider sx={{ mb: 1.5, mx: -2 }} />
      {isTransit ? (
        <TransitRouteOptions />
      ) : (
        <Box sx={{ display: "flex", gap: 4 }}>
          <Box sx={{ flex: 1 }}>
            <ColumnHeading label={t("avoid")} />
            {isDriving && (
              <>
                <CheckRow
                  label={t("highways")}
                  checked={avoidHighways}
                  onChange={setAvoidHighways}
                />
                <CheckRow label={t("tolls")} checked={avoidTolls} onChange={setAvoidTolls} />
              </>
            )}
            <CheckRow label={t("ferries")} checked={avoidFerries} onChange={setAvoidFerries} />
            <CheckRow label={t("closures")} checked={avoidIncidents} onChange={setAvoidIncidents} />
          </Box>
          <Box sx={{ flex: 1 }}>
            <ColumnHeading label={t("distance")} />
            <RadioRow
              label={t("kilometres")}
              selected={units === "metric"}
              onSelect={() => setUnits("metric")}
            />
            <RadioRow
              label={t("miles")}
              selected={units === "imperial"}
              onSelect={() => setUnits("imperial")}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
