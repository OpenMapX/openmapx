"use client";

import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { formatDuration } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";

/**
 * Transit arrival summary: names the destination and recaps the trip (total
 * travel time · arrival clock time), rather than the generic driving
 * {@link ArrivalCard}. Shown when the last leg completes.
 */
export function TransitArrivalCard({
  itinerary,
  onClose,
}: {
  itinerary: TripItinerary;
  onClose: () => void;
}) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  const destination = itinerary.legs[itinerary.legs.length - 1]?.to.name;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5, p: 3 }}>
      <PlaceIcon color="primary" sx={{ fontSize: 48 }} />
      <Typography variant="h6">{t("arrived")}</Typography>
      {destination && (
        <Typography variant="subtitle1" sx={{ fontWeight: 600, textAlign: "center" }}>
          {destination}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {formatDuration(itinerary.duration)} · {fmt.time(itinerary.endTime)}
      </Typography>
      <Button variant="contained" onClick={onClose} sx={{ mt: 1 }}>
        {t("done")}
      </Button>
    </Box>
  );
}
