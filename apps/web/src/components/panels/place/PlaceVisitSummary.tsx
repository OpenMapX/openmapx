"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { openingHoursTone } from "@/lib/openingHoursTone";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";

type SummaryPlace = Pick<Place, "category" | "openingHoursInfo">;

export function PlaceVisitSummary({
  place,
  compact = false,
}: {
  place: SummaryPlace;
  compact?: boolean;
}) {
  const hoursText = useOpeningHoursText();
  const status = place.openingHoursInfo?.status;

  if (!place.category && !status) return null;

  if (compact) {
    const category = place.category?.toLowerCase() === "poi" ? "POI" : place.category;
    const detail = status ? hoursText.detail(status) : "";
    return (
      <Typography
        data-testid="place-peek-summary"
        variant="body2"
        noWrap
        color="text.secondary"
        sx={{ display: "flex", columnGap: "0.25em", minWidth: 0, maxWidth: "100%" }}
      >
        {category && (
          <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {category}
          </Box>
        )}
        {category && status && (
          <Box component="span" sx={{ flexShrink: 0 }}>
            {" "}
            ·{" "}
          </Box>
        )}
        {status && (
          <Box
            component="span"
            sx={{
              minWidth: 0,
              flexShrink: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: openingHoursTone(status),
              fontWeight: status.isUnknown ? 500 : 700,
            }}
          >
            {hoursText.state(status)}
          </Box>
        )}
        {detail && (
          <Box component="span" sx={{ flexShrink: 0 }}>
            {" "}
            ·{" "}
          </Box>
        )}
        {detail && (
          <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {detail}
          </Box>
        )}
      </Typography>
    );
  }

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
          sx={{ color: openingHoursTone(status), fontWeight: 700, flexShrink: 0 }}
        >
          {hoursText.state(status)}
        </Typography>
      )}
    </Box>
  );
}
