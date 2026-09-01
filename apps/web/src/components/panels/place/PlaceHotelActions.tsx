"use client";

import CloseIcon from "@mui/icons-material/Close";
import HotelOutlinedIcon from "@mui/icons-material/HotelOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import {
  isLodging,
  type Place,
  useCountryFromCoordinates,
  useHotelConfig,
  useHotelOffers,
  useHotelSearchStore,
  useResolvedHotelProviders,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { HotelCompareList } from "./HotelCompareList";
import { HotelPriceBadge } from "./HotelPriceBadge";
import { HotelRateOptions } from "./HotelRateOptions";
import { HotelSearchControls } from "./HotelSearchControls";

/**
 * "Check availability" / compare-prices hand-off for lodging places. A pure
 * deep-link hand-off: the button opens a dialog with a date/occupancy picker
 * and a region-filtered OTA compare list. Self-hides for non-lodging places or
 * when no providers resolve.
 */
export function PlaceHotelActions({
  place,
  onOpenPrices,
}: {
  place: Place;
  onOpenPrices?: () => void;
}) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const lodging = isLodging(place);

  // Resolve a country from coordinates when the place carries none, so the OTA
  // list is region-filtered. Only fires for lodging places lacking a country.
  const { data: resolvedCountry } = useCountryFromCoordinates(
    place.coordinates,
    lodging && !place.countryCode,
  );
  const countryCode = place.countryCode ?? resolvedCountry ?? undefined;
  const [open, setOpen] = useState(false);
  // Hotel-aware: resolved only when the dialog is open (each resolve may do a
  // live Wikidata/typeahead lookup server-side; mirrors the deferred offers fetch).
  const { data: providersData } = useResolvedHotelProviders(
    {
      name: place.name,
      lat: place.coordinates[1],
      lng: place.coordinates[0],
      countryCode,
      wikidata: place.osmTags?.wikidata,
    },
    lodging && open,
  );

  const { data: config } = useHotelConfig(lodging);
  const liveEnabled = config?.liveEnabled ?? false;
  const { checkIn, checkOut, adults, rooms, currency, guestNationality } = useHotelSearchStore();
  // Only fetch the live rate once the compare dialog is open — the badge lives
  // inside it, so an unopened panel shouldn't spend a (paid) LiteAPI lookup. The
  // Prices tab fetches eagerly via its own hook; the sticky store shares the cache.
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
    lodging && liveEnabled && open,
  );

  const dialogTitleId = useId();

  if (!lodging) return null;
  // Booking.com (universal) always resolves for a lodging place, so the button
  // always has at least one option — no need to gate on the (now deferred) list.
  const providers = providersData?.providers ?? [];

  return (
    <Box sx={{ py: 0.5 }}>
      <Button
        fullWidth
        variant="contained"
        startIcon={<HotelOutlinedIcon />}
        onClick={() => setOpen(true)}
        sx={{
          bgcolor: BRAND,
          textTransform: "none",
          fontWeight: 600,
          borderRadius: 99,
          py: 1,
          "&:hover": { bgcolor: BRAND, filter: "brightness(0.92)" },
        }}
      >
        {t("checkAvailability")}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby={dialogTitleId}
        slotProps={{
          paper: {
            // Mirror DetailShell: in dark mode the default Dialog Paper picks
            // up MUI's elevation overlay (a translucent white wash), which
            // lightens the body and inverts the grey tones vs. the Prices tab.
            // Pin it to background.default (#1c1c1c) and drop the overlay so
            // the body stays the darker grey and the inputs (background.paper)
            // read as the lighter tone. Light mode keeps the default white.
            sx: (theme) => ({
              ...theme.applyStyles("dark", {
                bgcolor: "background.default",
                backgroundImage: "none",
              }),
            }),
          },
        }}
      >
        <Box sx={{ p: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", mb: 1.5 }}>
            <Typography id={dialogTitleId} variant="h6" sx={{ flex: 1, fontWeight: 600 }}>
              {t("comparePrices")}
            </Typography>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label={tc("close")}>
              <CloseIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Box>
          {offers?.best && <HotelPriceBadge offer={offers.best} />}
          <Box sx={{ mb: 2 }}>
            <HotelSearchControls />
            {liveEnabled && config && (
              <Box sx={{ mt: 1.25 }}>
                <HotelRateOptions
                  defaultCurrency={config.defaultCurrency}
                  placeCountry={countryCode}
                />
              </Box>
            )}
          </Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
            {t("allOptions")}
          </Typography>
          <HotelCompareList place={place} providers={providers} countryCode={countryCode} />
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 1.5 }}>
            {t("hotelNote")}
          </Typography>
          {onOpenPrices && (
            <Button
              fullWidth
              variant="text"
              onClick={() => {
                setOpen(false);
                onOpenPrices();
              }}
              sx={{ textTransform: "none", color: BRAND, mt: 0.5 }}
            >
              {t("seeAllPrices")}
            </Button>
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
