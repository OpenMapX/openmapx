// apps/web/src/components/panels/place/HotelPriceBadge.tsx
"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { HotelOffer } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";

/** "from €75 / night" reference price from a live offer (Tier 2). */
export function HotelPriceBadge({ offer }: { offer: HotelOffer }) {
  const t = useTranslations("place");
  const locale = useLocale();
  // offer.currency comes straight from the upstream rate; an invalid ISO-4217
  // code makes the Intl.NumberFormat constructor throw, which would crash this
  // (unguarded) render — degrade to a plain "amount CODE" instead.
  const formatPrice = (amount: number): string => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: offer.currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return `${Math.round(amount)} ${offer.currency}`;
    }
  };
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("priceFrom")}
      </Typography>
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
        {formatPrice(offer.nightlyFrom)}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("perNight")}
      </Typography>
    </Box>
  );
}
