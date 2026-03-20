import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import NextLink from "next/link";
import { getTranslations } from "next-intl/server";
import { TopRightControls } from "@/components/map/TopRightControls";
import { LegalTabBar } from "./LegalTabBar";

export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("legal");

  return (
    <Box
      sx={{
        position: "relative",
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      <TopRightControls />

      <Box component="header" sx={{ flexShrink: 0, borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ px: 3, pt: 1.5 }}>
          <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
            <NextLink href="/" style={{ textDecoration: "none" }}>
              <Typography
                sx={{
                  fontWeight: 700,
                  fontSize: 22,
                  color: "primary.main",
                  "&:hover": { textDecoration: "underline" },
                }}
              >
                OpenMapX
              </Typography>
            </NextLink>
            <Typography sx={{ fontSize: 16, color: "text.secondary" }}>{t("legal")}</Typography>
          </Box>
        </Box>

        <LegalTabBar
          pages={[
            { label: t("imprint"), href: "/imprint" },
            { label: t("privacyPolicy"), href: "/privacy" },
            { label: t("termsOfService"), href: "/terms" },
          ]}
        />
      </Box>

      {children}
    </Box>
  );
}
