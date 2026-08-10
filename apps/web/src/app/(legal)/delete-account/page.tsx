import Typography from "@mui/material/Typography";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { DeleteAccountActions } from "./DeleteAccountActions";

/**
 * The public account-deletion resource both stores require.
 *
 * It has to work for somebody who has already uninstalled the app, so it lives
 * on the website, names OpenMapX plainly, and never asks anyone to reinstall.
 *
 * It also has to be honest about what survives. Reviews published to Mangrove
 * are a public commons and are not ours to retract; limited security records are
 * kept and then unlinked. Saying "all your data is deleted" would be easier to
 * write and would be false.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("deleteAccountTitle")} — OpenMapX`,
    description: t("deleteAccountDescription"),
  };
}

export default async function DeleteAccountPage() {
  const t = await getTranslations("legal");

  const sections = [
    { id: "how", label: t("deleteAccountHowHeading") },
    { id: "what", label: t("deleteAccountWhatHeading") },
    { id: "kept", label: t("deleteAccountKeptHeading") },
    { id: "timing", label: t("deleteAccountTimingHeading") },
  ];

  return (
    <LegalPageShell sections={sections}>
      <Typography variant="h4" sx={{ mb: 2 }}>
        {t("deleteAccountTitle")}
      </Typography>
      <Typography sx={{ mb: 4 }}>{t("deleteAccountIntro")}</Typography>

      <Typography id="how" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("deleteAccountHowHeading")}
      </Typography>
      <Typography sx={{ mb: 2 }}>{t("deleteAccountInApp")}</Typography>
      <DeleteAccountActions />

      <Typography id="what" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("deleteAccountWhatHeading")}
      </Typography>
      <Typography>{t("deleteAccountWhatBody")}</Typography>

      <Typography id="kept" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("deleteAccountKeptHeading")}
      </Typography>
      <Typography>{t("deleteAccountKeptBody")}</Typography>

      <Typography id="timing" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("deleteAccountTimingHeading")}
      </Typography>
      <Typography>{t("deleteAccountTimingBody")}</Typography>
    </LegalPageShell>
  );
}
