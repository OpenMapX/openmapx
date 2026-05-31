// apps/web/src/components/panels/place/PlaceHotelPricesTab.tsx
"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { type Place, useCountryFromCoordinates, useHotelProviders } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { HotelCompareList } from "./HotelCompareList";
import { HotelSearchControls } from "./HotelSearchControls";

/**
 * The "Prices" tab for lodging places — Google Maps' "Compare prices /
 * All options" surface. Date/occupancy state is shared with the Overview block
 * via useHotelSearchStore. Tier 1 lists OTAs with hand-off links (no prices).
 */
export function PlaceHotelPricesTab({ place }: { place: Place }) {
  const t = useTranslations("place");
  const { data: resolvedCountry } = useCountryFromCoordinates(
    place.coordinates,
    !place.countryCode,
  );
  const countryCode = place.countryCode ?? resolvedCountry ?? undefined;
  const { data: providersData } = useHotelProviders(countryCode, true);
  const providers = providersData?.providers ?? [];

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {t("comparePrices")}
      </Typography>
      <HotelSearchControls />
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
          {t("allOptions")}
        </Typography>
        <HotelCompareList place={place} providers={providers} countryCode={countryCode} />
      </Box>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("hotelNote")}
      </Typography>
    </Box>
  );
}
