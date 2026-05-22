"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import ElevatorIcon from "@mui/icons-material/Elevator";
import EscalatorIcon from "@mui/icons-material/Escalator";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { Facility } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";

const FACILITY_ICONS: Record<Facility["type"], typeof ElevatorIcon> = {
  elevator: ElevatorIcon,
  escalator: EscalatorIcon,
  bike_storage: DirectionsBikeIcon,
  parking: LocalParkingIcon,
  other: MoreHorizIcon,
};

interface FacilitiesSectionProps {
  facilities: Facility[];
}

export function FacilitiesSection({ facilities }: FacilitiesSectionProps) {
  const t = useTranslations("transit");
  if (facilities.length === 0) return null;

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <Typography variant="subtitle2" gutterBottom>
        {t("facilities")}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {facilities.map((f) => {
          const Icon = FACILITY_ICONS[f.type];
          return (
            <Chip
              key={f.id}
              icon={<Icon fontSize="small" />}
              label={f.name}
              size="small"
              variant="outlined"
            />
          );
        })}
      </Box>
    </Box>
  );
}
