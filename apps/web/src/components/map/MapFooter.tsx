"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import { useSidebarStore } from "@openmapx/core";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { PANEL_WIDTH } from "@/lib/layout";

export function MapFooter() {
  const t = useTranslations("footer");
  const sidebarOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const shifted = sidebarOpen && !collapsed;
  return (
    <Box
      component="footer"
      sx={{
        position: "absolute",
        bottom: "var(--omx-safe-bottom)",
        left: {
          xs: "var(--omx-safe-left)",
          sm: shifted ? `calc(${PANEL_WIDTH}px + var(--omx-safe-left))` : "var(--omx-safe-left)",
        },
        zIndex: 5,
        display: "flex",
        gap: "0.6em",
        bgcolor: "color-mix(in srgb, var(--omx-overlay-bg) 50%, transparent)",
        px: "5px",
        font: '12px/20px "Helvetica Neue", Arial, Helvetica, sans-serif',
        transition: "left 0.25s ease",
        "& a": {
          color: "text.primary",
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
      <Link component={NextLink} href="/licenses">
        {t("licenses")}
      </Link>
    </Box>
  );
}
