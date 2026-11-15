"use client";

import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { formatDuration } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { tripPlaceName } from "@/components/panels/directions/transitSummary";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { useTripEndLabels } from "@/lib/navigation/useTripEndLabels";

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
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const labels = useTripEndLabels();
  const last = itinerary.legs[itinerary.legs.length - 1];
  const destination = last && tripPlaceName(last.to, labels.destination);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, p: { xs: 2, sm: 3 } }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5 }}>
        <PlaceIcon color="primary" sx={{ fontSize: 28, mt: 0.25 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" color="text.secondary">
            {t("arrived")}
          </Typography>
          {destination && (
            <Typography component="h2" sx={{ fontSize: 22, fontWeight: 500, lineHeight: 1.3 }}>
              {destination}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {formatDuration(itinerary.duration, locale)} · {fmt.time(itinerary.endTime)}
          </Typography>
        </Box>
      </Box>
      <Box>
        <Button variant="contained" onClick={onClose}>
          {t("done")}
        </Button>
      </Box>
    </Box>
  );
}
