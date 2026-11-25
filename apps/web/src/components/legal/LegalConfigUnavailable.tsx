import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import { getTranslations } from "next-intl/server";

/**
 * Shown instead of a legal page when the API cannot supply the operator's
 * legal facts. The page states nothing rather than values the operator did
 * not configure.
 */
export async function LegalConfigUnavailable() {
  const t = await getTranslations("legal");
  return (
    <Alert severity="error" role="alert">
      <AlertTitle>{t("configUnavailableTitle")}</AlertTitle>
      {t("configUnavailable")}
    </Alert>
  );
}
