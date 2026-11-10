import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ForgetCallbackQuery } from "./ForgetCallbackQuery";

/**
 * Where the browser lands when the operating system did not hand the sign-in
 * callback to the app: no app installed, its association not yet verified, or a
 * development build against a plain-HTTP origin.
 *
 * The page never reads the query. The callback code in it is single-use, expires
 * within two minutes and cannot be redeemed without the verifier only the app
 * holds; the address is still cleared so the code does not linger in history.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mobileAuth");
  return {
    title: `${t("callbackTitle")} · OpenMapX`,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function MobileAuthCallbackPage() {
  const t = await getTranslations("mobileAuth");
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
      <ForgetCallbackQuery />
      <Box sx={{ maxWidth: 420, textAlign: "center" }}>
        <Typography variant="h6" component="h1" sx={{ mb: 1 }}>
          {t("callbackTitle")}
        </Typography>
        <Typography sx={{ color: "text.secondary" }}>{t("callbackBody")}</Typography>
      </Box>
    </Box>
  );
}
