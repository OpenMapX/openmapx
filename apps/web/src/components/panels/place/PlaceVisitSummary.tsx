"use client";

import Box from "@mui/material/Box";
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

  const category = place.category?.toLowerCase() === "poi" ? "POI" : place.category;
  const detail = status ? hoursText.detail(status) : "";
  // One line: category · hours state · detail. The compact (peek) form keeps it
  // to a single line and truncates; the full form wraps.
  const part = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } as const;
  const separator = (
    <Box component="span" sx={{ flexShrink: 0 }}>
      {" "}
      ·{" "}
    </Box>
  );
  return (
    <Typography
      data-testid={compact ? "place-peek-summary" : "place-visit-summary"}
      variant="body2"
      noWrap={compact}
      sx={{
        color: "text.secondary",
        display: "flex",
        flexWrap: compact ? "nowrap" : "wrap",
        columnGap: "0.25em",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      {category && (
        <Box component="span" sx={part}>
          {category}
        </Box>
      )}
      {category && status && separator}
      {status && (
        <Box
          component="span"
          sx={{
            ...part,
            flexShrink: 0,
            color: openingHoursTone(status),
            fontWeight: status.isUnknown ? 500 : 600,
          }}
        >
          {hoursText.state(status)}
        </Box>
      )}
      {detail && separator}
      {detail && (
        <Box component="span" sx={part}>
          {detail}
        </Box>
      )}
    </Typography>
  );
}
