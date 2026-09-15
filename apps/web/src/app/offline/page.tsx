import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { OfflineActions } from "./OfflineActions";

export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("offline");
  return {
    title: `${t("pageTitle")} · OpenMapX`,
    description: t("pageDescription"),
    robots: { index: false, follow: false },
  };
}

export default async function OfflinePage() {
  const t = await getTranslations("offline");

  return (
    <Box
      component="main"
      sx={{
        display: "flex",
        minHeight: "100dvh",
        alignItems: "center",
        justifyContent: "center",
        px: 3,
        py: 5,
      }}
    >
      <Box sx={{ width: "100%", maxWidth: 448, textAlign: "center" }}>
        <Box
          sx={{
            mx: "auto",
            mb: 3,
            display: "flex",
            width: 64,
            height: 64,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            bgcolor: "var(--omx-brand-light)",
            color: "var(--omx-brand)",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>Offline</title>
            <path d="M2 2l20 20" />
            <path d="M8.5 16.5a5 5 0 017 0" />
            <path d="M2 8.82a15 15 0 014.17-2.65" />
            <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
            <path d="M16.85 11.25a10 10 0 015.15 1.5" />
            <path d="M5 13.06a10 10 0 015.17-1.46" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </Box>

        <Typography
          component="h1"
          sx={{
            mb: 1.5,
            fontSize: 24,
            lineHeight: "32px",
            fontWeight: 600,
            letterSpacing: "-0.025em",
          }}
        >
          {t("pageTitle")}
        </Typography>
        <Typography
          sx={{
            mb: 4,
            fontSize: 14,
            lineHeight: "20px",
            color: "var(--omx-overlay-text)",
            opacity: 0.7,
          }}
        >
          {t("pageDescription")}
        </Typography>

        <Box
          sx={{
            mb: 4,
            p: 2,
            borderRadius: 1,
            bgcolor: "var(--omx-overlay-bg)",
            textAlign: "left",
            fontSize: 14,
            lineHeight: "20px",
            boxShadow:
              "0 0 0 1px var(--omx-border-light), 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
          }}
        >
          <Typography
            component="h2"
            sx={{ mb: 1, fontSize: "inherit", lineHeight: "inherit", fontWeight: 500 }}
          >
            {t("stillWorks")}
          </Typography>
          <Box
            component="ul"
            sx={{ display: "flex", flexDirection: "column", gap: 0.75, opacity: 0.8 }}
          >
            <li>• {t("stillWorksTiles")}</li>
            <li>• {t("stillWorksRoutes")}</li>
            <li>• {t("stillWorksDownloaded")}</li>
          </Box>
        </Box>

        <OfflineActions retryLabel={t("retry")} openMapLabel={t("openMap")} />
      </Box>
    </Box>
  );
}
