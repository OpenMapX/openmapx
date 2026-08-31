"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";

export function DirectionsDetailHeader({
  originLabel,
  destinationLabel,
  viaLabels = [],
  onBack,
}: {
  originLabel: string;
  destinationLabel: string;
  viaLabels?: string[];
  onBack: () => void;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const intermediateLabels = viaLabels.filter(Boolean);
  const via =
    intermediateLabels.length > 0 ? t("via", { stops: intermediateLabels.join(", ") }) : null;

  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.5, pt: 2, pb: 1 }}>
      <IconButton
        size="small"
        onClick={onBack}
        aria-label={tc("back")}
        sx={{ mt: 0.25, flexShrink: 0 }}
      >
        <ArrowBackIcon sx={{ fontSize: 20 }} />
      </IconButton>
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("from")}{" "}
          <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
            {originLabel || t("origin")}
          </Box>
        </Typography>
        <br />
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("to")}{" "}
          <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
            {destinationLabel || t("destination")}
          </Box>
        </Typography>
        {via && (
          <>
            <br />
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {via}
            </Typography>
          </>
        )}
      </Box>
    </Box>
  );
}
