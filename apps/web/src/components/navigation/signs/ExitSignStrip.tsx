"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { type ManeuverSign, signHeadline, visibleToward } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { RouteShield } from "./RouteShield";
import { signPalette } from "./signPalette";

interface Props {
  sign: ManeuverSign;
  /** ISO 3166-1 alpha-2 country of the route origin; null falls back to the EU palette. */
  country?: string | null;
  size?: "banner" | "compact";
}

/**
 * One interchange-signage line: exit-number badge, route-ref shields, then
 * toward destinations (or the exit name when no toward list exists). One
 * line, no wrap, ellipsised from the right. Plain text throughout, so the
 * banner's live region reads it as "Exit 20, A 46, Neuss-Zentrum".
 */
export function ExitSignStrip({ sign, country, size = "banner" }: Props) {
  const t = useTranslations("navigation");
  const exitNumber = sign.exitNumbers?.[0];
  const shields = visibleToward(sign.exitBranches ?? [], 3);
  const headline = visibleToward(signHeadline(sign));
  const palette = signPalette(country ?? null);
  if (!exitNumber && shields.length === 0 && headline.length === 0) return null;
  return (
    <Box
      // In the banner the distance heading above sits at line-height 1.1 while the
      // instruction below keeps body1's taller leading; the top margin evens the gaps.
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        minWidth: 0,
        mt: size === "banner" ? 0.5 : 0,
      }}
      data-testid="exit-sign-strip"
    >
      {exitNumber && (
        <Box
          component="span"
          data-testid="exit-number-badge"
          data-bg={palette.exitBadge.bg}
          sx={{
            bgcolor: palette.exitBadge.bg,
            color: palette.exitBadge.fg,
            borderRadius: 1,
            px: 0.75,
            py: 0.25,
            fontWeight: 700,
            fontSize: size === "banner" ? 13 : 11,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {t("exitNumber", { number: exitNumber })}
        </Box>
      )}
      {shields.map((roadRef) => (
        <RouteShield key={roadRef} roadRef={roadRef} country={country} size={size} />
      ))}
      {headline.length > 0 && (
        <Typography
          component="span"
          variant={size === "banner" ? "body2" : "caption"}
          sx={{ whiteSpace: "nowrap", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {headline.join(" · ")}
        </Typography>
      )}
    </Box>
  );
}
