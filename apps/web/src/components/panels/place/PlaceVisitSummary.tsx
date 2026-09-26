"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";

type SummaryPlace = Pick<Place, "category" | "openingHoursInfo">;

export function PlaceVisitSummary({ place }: { place: SummaryPlace }) {
  const hoursText = useOpeningHoursText();
  const status = place.openingHoursInfo?.status;

  if (!place.category && !status) return null;

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, overflow: "hidden" }}>
      {place.category && (
        <Chip
          label={place.category.toLowerCase() === "poi" ? "POI" : place.category}
          size="small"
          sx={{
            borderRadius: "4px",
            fontSize: 12,
            minWidth: 0,
            maxWidth: "100%",
            "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
          }}
        />
      )}
      {status && (
        <Typography
          variant="body2"
          component="span"
          noWrap
          color={
            status.isUnknown ? "text.secondary" : status.isOpen ? "success.main" : "error.main"
          }
          sx={{ fontWeight: 500, flexShrink: 0 }}
        >
          {hoursText.state(status)}
        </Typography>
      )}
    </Box>
  );
}
