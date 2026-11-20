"use client";

import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import EvStationIcon from "@mui/icons-material/EvStation";
import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import type { TravelMode } from "@openmapx/core";
import { formatDuration } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorsForField } from "@openmapx/mobility-core/contributors";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { MODES, ModeButton } from "@/components/panels/directions/ModeSelector";
import type { ModeDuration } from "./useGroundDirectionsPlan";

type DurationRecord = Parameters<typeof contributorsForField>[0] & { duration?: number };

interface TravelModeButtonsInput {
  mode: TravelMode;
  /** The active mode's first route or itinerary, once it is planned. */
  activeRecord: DurationRecord | undefined;
  /** Whether the active mode's plan is still loading. */
  activeLoading: boolean;
  cachedDuration: (mode: TravelMode) => ModeDuration | undefined;
  locale: string;
}

export interface TravelModeButton {
  mode: TravelMode;
  icon: ReactNode;
  labelKey: string;
  disabled?: boolean;
  isActive: boolean;
  loading: boolean;
  time: string | undefined;
  contributors: Attribution[];
}

/** Each mode button's duration and the receipts that own its text, derived together. */
export function travelModeButtons({
  mode,
  activeRecord,
  activeLoading,
  cachedDuration,
  locale,
}: TravelModeButtonsInput): TravelModeButton[] {
  return MODES.map((button) => {
    const isActive = mode === button.mode;
    const isTransit = button.mode === "transit";
    const cached = isTransit || button.disabled ? undefined : cachedDuration(button.mode);
    const record = isActive ? activeRecord : undefined;
    const planned =
      record?.duration !== undefined
        ? {
            time: formatDuration(record.duration, locale),
            contributors: contributorsForField(record, "duration"),
          }
        : cached;
    const duration = button.disabled ? undefined : planned;
    // A cached duration stands in while the active mode's plan loads.
    const loading = isActive && activeLoading && !cached;
    return {
      ...button,
      isActive,
      loading,
      time: duration?.time,
      contributors: !loading && duration ? duration.contributors : [],
    };
  });
}

interface TravelModeRowProps {
  buttons: readonly TravelModeButton[];
  onSelect: (mode: TravelMode) => void;
}

export function TravelModeRow({ buttons, onSelect }: TravelModeRowProps) {
  const t = useTranslations("directions");
  return (
    <Box
      role="radiogroup"
      aria-label={t("travelMode")}
      sx={{
        display: "flex",
        width: "100%",
        boxSizing: "border-box",
        px: "6px",
        pb: 0.25,
        justifyContent: "space-around",
        flexWrap: "wrap",
      }}
    >
      {buttons.map(({ mode, icon, labelKey, disabled, isActive, time, loading }) => (
        <ModeButton
          key={mode}
          mode={mode}
          name="travel-mode"
          icon={icon}
          label={t(labelKey)}
          time={time}
          active={isActive}
          disabled={disabled}
          loading={loading}
          onClick={() => onSelect(mode)}
        />
      ))}
    </Box>
  );
}

interface DrivingKindRowProps {
  isEvMode: boolean;
  inSheet: boolean;
  /** The departure chip, when it shares this row in a phone's sheet. */
  timeChip: ReactNode;
  onChange: (ev: boolean) => void;
}

/**
 * Driving sub-mode: normal route vs. EV charge planning. EV is a subtype of
 * driving, not its own top-level mode, so it lives here rather than in the
 * mode row.
 */
export function DrivingKindRow({ isEvMode, inSheet, timeChip, onChange }: DrivingKindRowProps) {
  const t = useTranslations("directions");
  return (
    // Beside the panel the fields follow, so it lines up with them:
    // WaypointList's px (12px) + WaypointRow's 24px icon column + its 4px gap.
    // In a phone's sheet the fields float above the map; it lines up with
    // the sheet's content and keeps its distance from the divider below.
    <Box
      sx={[
        inSheet ? { px: 2, pt: 1, pb: 1.5 } : { pl: 5, pr: 1.5, pt: 1 },
        { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 },
      ]}
    >
      {/* Departure first, where transit has it too. */}
      {timeChip}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={isEvMode ? "ev" : "route"}
        onChange={(_, value) => {
          if (value) onChange(value === "ev");
        }}
        aria-label={t("driving")}
        sx={{ "& .MuiToggleButton-root": { textTransform: "none", py: 0.3, px: 1.2 } }}
      >
        <ToggleButton value="route">
          <DirectionsCarIcon sx={{ fontSize: 18, mr: 0.5 }} />
          {t("driving")}
        </ToggleButton>
        <ToggleButton value="ev">
          <EvStationIcon sx={{ fontSize: 18, mr: 0.5 }} />
          {t("evMode")}
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}
