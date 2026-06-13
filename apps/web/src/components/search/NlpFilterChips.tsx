"use client";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";

/**
 * Subtle notice listing the attributes from an NLP query that could not be
 * mapped to a structured filter (e.g. "best", "instagrammable"). Renders
 * nothing when there are no unmapped attributes.
 */
export function NlpUnmappedNotice({ attributes }: { attributes: string[] }) {
  const t = useTranslations("search");
  if (attributes.length === 0) return null;

  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        color: "text.secondary",
        pointerEvents: "auto",
        // Give the notice an opaque pill background — it floats over the map, so
        // without this the muted caption is nearly unreadable against the tiles.
        bgcolor: "background.paper",
        px: 1.25,
        py: 0.5,
        borderRadius: 2,
        boxShadow: 2,
        maxWidth: "100%",
      }}
    >
      <InfoOutlinedIcon sx={{ fontSize: 16, flexShrink: 0 }} />
      <Typography variant="caption" sx={{ lineHeight: 1.3 }}>
        {t("couldNotFilterBy")} {attributes.join(", ")}
      </Typography>
    </Box>
  );
}
