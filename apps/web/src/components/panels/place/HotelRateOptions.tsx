"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useHotelSearchStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { type ChangeEvent, useMemo } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

/** Curated currency choices (extensible; the effective currency is prepended if missing). */
const CURRENCIES = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "CAD",
  "AUD",
  "JPY",
];
/** Curated ISO-3166-1 alpha-2 nationality choices (the place's country is prepended if missing). */
const NATIONALITIES = [
  "US",
  "GB",
  "DE",
  "FR",
  "ES",
  "IT",
  "NL",
  "BE",
  "AT",
  "CH",
  "SE",
  "NO",
  "DK",
  "PL",
  "CZ",
  "IE",
  "PT",
  "CA",
  "AU",
  "JP",
  "CN",
  "IN",
  "BR",
  "MX",
];

const selectSx = {
  border: "1px solid",
  borderColor: "divider",
  borderRadius: 1.5,
  bgcolor: "background.paper",
  color: "text.primary",
  fontSize: 14,
  px: 1,
  py: 0.75,
  width: "100%",
  fontFamily: "inherit",
  "&:focus": { outline: "none", borderColor: BRAND },
} as const;

export function HotelRateOptions({
  defaultCurrency,
  placeCountry,
}: {
  defaultCurrency: string;
  placeCountry?: string;
}) {
  const t = useTranslations("place");
  const locale = useLocale();
  const { currency, guestNationality, setCurrency, setGuestNationality } = useHotelSearchStore();

  const effCurrency = currency || defaultCurrency;
  // placeCountry can be a non-ISO-alpha-2 value (e.g. an OSM `addr:country` tag
  // like "USA" or "Deutschland"); fall back to "US" so it never reaches the
  // option list / Intl below as an invalid region subtag.
  const effNationality =
    guestNationality ||
    (placeCountry && /^[A-Za-z]{2}$/.test(placeCountry) ? placeCountry.toUpperCase() : "US");
  const currencyChoices = CURRENCIES.includes(effCurrency)
    ? CURRENCIES
    : [effCurrency, ...CURRENCIES];
  const nationChoices = NATIONALITIES.includes(effNationality)
    ? NATIONALITIES
    : [effNationality, ...NATIONALITIES];
  const regionNames = useMemo(() => new Intl.DisplayNames(locale, { type: "region" }), [locale]);
  // Intl.DisplayNames.of THROWS (not returns undefined) on a structurally
  // invalid region subtag, so a bad code would crash render — fall back to the
  // raw code instead.
  const regionLabel = (cc: string): string => {
    try {
      return regionNames.of(cc) ?? cc;
    } catch {
      return cc;
    }
  };

  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("currency")}
        </Typography>
        <Box
          component="select"
          value={effCurrency}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}
          sx={selectSx}
        >
          {currencyChoices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Box>
      </Box>
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("guestNationality")}
        </Typography>
        <Box
          component="select"
          value={effNationality}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setGuestNationality(e.target.value)}
          sx={selectSx}
        >
          {nationChoices.map((cc) => (
            <option key={cc} value={cc}>
              {regionLabel(cc)}
            </option>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
