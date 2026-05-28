"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import type { IsochroneTravelMode } from "@openmapx/core";
import { useCategorySearchStore } from "@openmapx/core";
import { useTranslations } from "next-intl";

const MINUTE_OPTIONS = [5, 10, 15, 30, 45, 60];

export function ExploreTravelTimeControl() {
  const t = useTranslations("search");
  const td = useTranslations("directions");
  const travelTime = useCategorySearchStore((s) => s.travelTime);
  const setTravelTime = useCategorySearchStore((s) => s.setTravelTime);

  return (
    <Box sx={{ px: 2, py: 1.5, borderBottom: "1px solid var(--omx-border)" }}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={travelTime.enabled}
            onChange={(e) => setTravelTime({ enabled: e.target.checked })}
          />
        }
        label={
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {t("travelTime")}
          </Typography>
        }
      />
      {travelTime.enabled && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1, mt: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={travelTime.mode}
              onChange={(_, v: IsochroneTravelMode | null) => v && setTravelTime({ mode: v })}
            >
              <ToggleButton value="walking" aria-label={td("walking")}>
                <DirectionsWalkIcon fontSize="small" />
              </ToggleButton>
              <ToggleButton value="cycling" aria-label={td("cycling")}>
                <DirectionsBikeIcon fontSize="small" />
              </ToggleButton>
              <ToggleButton value="driving" aria-label={td("driving")}>
                <DirectionsCarIcon fontSize="small" />
              </ToggleButton>
            </ToggleButtonGroup>
            <Select
              size="small"
              value={travelTime.minutes}
              onChange={(e) => setTravelTime({ minutes: Number(e.target.value) })}
              sx={{ minWidth: 96 }}
            >
              {MINUTE_OPTIONS.map((m) => (
                <MenuItem key={m} value={m}>
                  {t("minutesShort", { minutes: m })}
                </MenuItem>
              ))}
            </Select>
          </Box>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={travelTime.onlyWithinReach}
                onChange={(e) => setTravelTime({ onlyWithinReach: e.target.checked })}
              />
            }
            label={<Typography variant="body2">{t("onlyWithinReach")}</Typography>}
          />
        </Box>
      )}
    </Box>
  );
}
