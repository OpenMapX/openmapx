"use client";

import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import {
  TRANSIT_ACCESS_OPTIONS,
  TRANSIT_PREFER_OPTIONS,
  type TransitAccessMode,
  type TransitRoutePreference,
  useDirectionsStore,
  useRouteInGermany,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { TEAL } from "@/lib/theme";

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
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.5,
        cursor: "pointer",
        "&:hover": { color: TEAL },
      }}
    >
      {checked ? (
        <CheckBoxIcon sx={{ fontSize: 20, color: TEAL }} />
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
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      onClick={onSelect}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.5,
        cursor: "pointer",
        "&:hover": { color: TEAL },
      }}
    >
      {selected ? (
        <RadioButtonCheckedIcon sx={{ fontSize: 20, color: TEAL }} />
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
  { value: "wheelchair", labelKey: "wheelchairAccessible" },
];

const ACCESS_MODE_LABEL_KEYS: Record<TransitAccessMode, string> = {
  walk: "accessWalk",
  bike: "accessBike",
  car: "accessCar",
};

function TransitRouteOptions() {
  const t = useTranslations("directions");
  const origin = useDirectionsStore((s) => s.origin);
  const destination = useDirectionsStore((s) => s.destination);
  const transitPreferredModes = useDirectionsStore((s) => s.transitPreferredModes);
  const toggleTransitPreferredMode = useDirectionsStore((s) => s.toggleTransitPreferredMode);
  const transitRoutePreference = useDirectionsStore((s) => s.transitRoutePreference);
  const setTransitRoutePreference = useDirectionsStore((s) => s.setTransitRoutePreference);
  const transitAccessMode = useDirectionsStore((s) => s.transitAccessMode);
  const setTransitAccessMode = useDirectionsStore((s) => s.setTransitAccessMode);
  const deutschlandticketOnly = useDirectionsStore((s) => s.deutschlandticketOnly);
  const setDeutschlandticketOnly = useDirectionsStore((s) => s.setDeutschlandticketOnly);

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
        <ColumnHeading label={t("gettingThere")} />
        <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {TRANSIT_ACCESS_OPTIONS.map((m) => (
            <RadioRow
              key={m}
              label={t(ACCESS_MODE_LABEL_KEYS[m])}
              selected={transitAccessMode === m}
              onSelect={() => setTransitAccessMode(m)}
            />
          ))}
        </Box>
      </Box>
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
