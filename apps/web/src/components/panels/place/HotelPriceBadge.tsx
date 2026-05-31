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
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: offer.currency,
    maximumFractionDigits: 0,
  });
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5 }}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("priceFrom")}
      </Typography>
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
        {fmt.format(offer.nightlyFrom)}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {t("perNight")}
      </Typography>
    </Box>
  );
}
