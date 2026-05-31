// apps/web/src/components/panels/place/PlaceHotelPricesTab.tsx
"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  type Place,
  useCountryFromCoordinates,
  useHotelConfig,
  useHotelOffers,
  useHotelSearchStore,
  useResolvedHotelProviders,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { HotelCompareList } from "./HotelCompareList";
import { HotelPriceBadge } from "./HotelPriceBadge";
import { HotelRateOptions } from "./HotelRateOptions";
import { HotelSearchControls } from "./HotelSearchControls";

/**
 * The "Prices" tab for lodging places — Google Maps' "Compare prices /
 * All options" surface. Date/occupancy state is shared with the Overview block
 * via useHotelSearchStore. Tier 1 lists OTAs with hand-off links (no prices).
 * Tier 2 (when liveEnabled) adds a live "from €X / night" badge and editable
 * currency + guest-nationality controls.
 */
export function PlaceHotelPricesTab({ place }: { place: Place }) {
  const t = useTranslations("place");
  const { data: resolvedCountry } = useCountryFromCoordinates(
    place.coordinates,
    !place.countryCode,
  );
  const countryCode = place.countryCode ?? resolvedCountry ?? undefined;
  const { data: providersData } = useResolvedHotelProviders({
    name: place.name,
    lat: place.coordinates[1],
    lng: place.coordinates[0],
    countryCode,
    wikidata: place.osmTags?.wikidata,
  });
  const providers = providersData?.providers ?? [];

  const { data: config } = useHotelConfig();
  const liveEnabled = config?.liveEnabled ?? false;
  const { checkIn, checkOut, adults, rooms, currency, guestNationality } = useHotelSearchStore();
  const { data: offers } = useHotelOffers(
    {
      name: place.name,
      lat: place.coordinates[1],
      lng: place.coordinates[0],
      countryCode,
      checkIn,
      checkOut,
      adults,
      rooms,
      currency: currency || config?.defaultCurrency,
      guestNationality: guestNationality || countryCode?.toUpperCase(),
    },
    liveEnabled,
  );

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {t("comparePrices")}
      </Typography>
      {offers?.best && <HotelPriceBadge offer={offers.best} />}
      {liveEnabled && config && (
        <HotelRateOptions defaultCurrency={config.defaultCurrency} placeCountry={countryCode} />
      )}
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
