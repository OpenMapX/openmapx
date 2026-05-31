// apps/web/src/components/panels/place/PlaceHotelActions.tsx
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
  useHotelProviders,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { TEAL } from "@/lib/theme";
import { HotelCompareList } from "./HotelCompareList";
import { HotelSearchControls } from "./HotelSearchControls";

/**
 * "Check availability" / compare-prices hand-off for lodging places, mirroring
 * Google Maps' hotel Overview block. Tier 1 is a pure deep-link hand-off (see
 * docs/plans/hotel-prices-and-booking.md): the button opens a dialog with a
 * date/occupancy picker and a region-filtered OTA compare list. Self-hides for
 * non-lodging places or when no providers resolve.
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
  const { data: providersData } = useHotelProviders(countryCode, lodging);

  const [open, setOpen] = useState(false);
  const dialogTitleId = useId();

  if (!lodging) return null;
  const providers = providersData?.providers ?? [];
  if (providers.length === 0 && !place.website) return null;

  return (
    <Box sx={{ py: 0.5 }}>
      <Button
        fullWidth
        variant="contained"
        startIcon={<HotelOutlinedIcon />}
        onClick={() => setOpen(true)}
        sx={{
          bgcolor: TEAL,
          textTransform: "none",
          fontWeight: 600,
          borderRadius: 99,
          py: 1,
          "&:hover": { bgcolor: TEAL, filter: "brightness(0.92)" },
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
          <Box sx={{ mb: 2 }}>
            <HotelSearchControls />
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
              sx={{ textTransform: "none", color: TEAL, mt: 0.5 }}
            >
              {t("seeAllPrices")}
            </Button>
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
