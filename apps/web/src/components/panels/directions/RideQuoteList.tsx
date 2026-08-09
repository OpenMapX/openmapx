"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { RideQuote } from "@openmapx/core";
import { formatDuration } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { BRAND } from "@/lib/theme";

function formatFare(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    // A feed can publish a currency code Intl does not know; showing the raw
    // number beats showing nothing.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * The product rows for one provider's quotes. A fare computed locally from a
 * published tariff is always labelled as an estimate — the user must be able
 * to tell it apart from a price the operator actually quoted.
 */
export function RideQuoteList({
  providerName,
  quotes,
  expired,
  onBook,
  locale = "en",
}: {
  providerName: string;
  quotes: RideQuote[];
  expired: boolean;
  onBook: (productId: string) => void;
  locale?: string;
}) {
  const t = useTranslations("directions");

  if (quotes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t("rideNoQuotes", { provider: providerName })}
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {expired && (
        <Typography variant="caption" color="warning.main">
          {t("rideQuoteExpired")}
        </Typography>
      )}

      {quotes.map((quote) => (
        <Box
          key={quote.productId}
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            px: 1.25,
            py: 1,
            border: "1px solid",
            borderColor: "divider",
            borderRadius: "10px",
            opacity: expired ? 0.5 : 1,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
              {quote.product.name}
            </Typography>
            {quote.pickupEtaSeconds !== undefined && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                {t("rideEta", { duration: formatDuration(quote.pickupEtaSeconds) })}
              </Typography>
            )}
            {quote.fare?.basis === "estimated" && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                {t("rideFareEstimated")}
              </Typography>
            )}
            {quote.disclaimer && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                {quote.disclaimer}
              </Typography>
            )}
          </Box>

          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
            {quote.fare && (
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {quote.fare.display ??
                  (quote.fare.amount !== undefined
                    ? formatFare(quote.fare.amount, quote.fare.currency, locale)
                    : "")}
              </Typography>
            )}
            <Box
              component="button"
              type="button"
              disabled={expired}
              onClick={() => onBook(quote.productId)}
              sx={{
                border: "none",
                borderRadius: "8px",
                px: 1.5,
                py: 0.75,
                bgcolor: BRAND,
                color: "#fff",
                fontSize: "0.8rem",
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                "&:hover": { opacity: 0.9 },
                "&:disabled": { opacity: 0.4, cursor: "default" },
              }}
            >
              {t("rideBook")}
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
