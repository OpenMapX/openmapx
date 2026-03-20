"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

export function MapFooter() {
  const t = useTranslations("footer");
  return (
    <Box
      component="footer"
      sx={{
        position: "absolute",
        bottom: 0,
        left: 0,
        zIndex: 5,
        display: "flex",
        gap: "0.6em",
        pointerEvents: "auto",
        bgcolor: "rgba(255, 255, 255, 0.5)",
        px: "5px",
        font: '12px/20px "Helvetica Neue", Arial, Helvetica, sans-serif',
        "& a": {
          color: "rgba(0, 0, 0, 0.75)",
          textDecoration: "none",
          font: "inherit",
          "&:hover": { textDecoration: "underline" },
        },
      }}
    >
      <Link component={NextLink} href="/imprint">
        {t("legalNotice")}
      </Link>
      <Link component={NextLink} href="/privacy">
        {t("privacy")}
      </Link>
      <Link component={NextLink} href="/terms">
        {t("terms")}
      </Link>
    </Box>
  );
}
