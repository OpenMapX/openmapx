"use client";

import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import { useDirectionsStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { TEAL } from "@/lib/theme";

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

export function RouteOptions() {
  const t = useTranslations("directions");
  const {
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
    setAvoidHighways,
    setAvoidTolls,
    setAvoidFerries,
    setUnits,
  } = useDirectionsStore();

  return (
    <Box sx={{ px: 2, pb: 1.5 }}>
      <Divider sx={{ mb: 1.5, mx: -2 }} />
      <Box sx={{ display: "flex", gap: 4 }}>
        <Box sx={{ flex: 1 }}>
          <Typography
            variant="caption"
            fontWeight={600}
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            {t("avoid")}
          </Typography>
          <CheckRow label={t("highways")} checked={avoidHighways} onChange={setAvoidHighways} />
          <CheckRow label={t("tolls")} checked={avoidTolls} onChange={setAvoidTolls} />
          <CheckRow label={t("ferries")} checked={avoidFerries} onChange={setAvoidFerries} />
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography
            variant="caption"
            fontWeight={600}
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            {t("distance")}
          </Typography>
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
    </Box>
  );
}
