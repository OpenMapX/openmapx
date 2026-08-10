import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalPageShell } from "@/components/legal/LegalPageShell";

/**
 * The stable support URL the app stores point at.
 *
 * Both stores require a support address that keeps working, so this page is
 * deliberately plain: no account needed, no app needed, and every link a person
 * with a broken app might want in one place. The three troubleshooting entries
 * are the three things that are genuinely confusing about a navigation app whose
 * UI is served over the network, and each says what is actually happening rather
 * than telling somebody to reinstall.
 */

export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("supportTitle")} — OpenMapX`,
    description: t("supportDescription"),
  };
}

export default async function SupportPage() {
  const t = await getTranslations("legal");

  const sections = [
    { id: "contact", label: t("supportContactHeading") },
    { id: "troubleshooting", label: t("supportTroubleshootingHeading") },
    { id: "links", label: t("supportLinksHeading") },
  ];

  return (
    <LegalPageShell sections={sections}>
      <Typography variant="h4" sx={{ mb: 2 }}>
        {t("supportTitle")}
      </Typography>
      <Typography sx={{ mb: 4 }}>{t("supportIntro")}</Typography>

      <Typography id="contact" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("supportContactHeading")}
      </Typography>
      <Typography sx={{ mb: 1 }}>{t("supportContactBody")}</Typography>
      <Link href="mailto:support@openmapx.com">support@openmapx.com</Link>

      <Typography id="troubleshooting" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("supportTroubleshootingHeading")}
      </Typography>
      <Stack spacing={2}>
        <div>
          <Typography sx={{ fontWeight: 600 }}>{t("supportNavigationStops")}</Typography>
          <Typography>{t("supportNavigationStopsBody")}</Typography>
        </div>
        <div>
          <Typography sx={{ fontWeight: 600 }}>{t("supportOfflineHeading")}</Typography>
          <Typography>{t("supportOfflineBody")}</Typography>
        </div>
        <div>
          <Typography sx={{ fontWeight: 600 }}>{t("supportAlertHeading")}</Typography>
          <Typography>{t("supportAlertBody")}</Typography>
        </div>
      </Stack>

      <Typography id="links" variant="h6" sx={{ mt: 4, mb: 1 }}>
        {t("supportLinksHeading")}
      </Typography>
      <Stack spacing={1}>
        <Link href="/privacy">{t("privacyPolicy")}</Link>
        <Link href="/terms">{t("termsOfService")}</Link>
        <Link href="/licenses">{t("openSourceLicenses")}</Link>
        <Link href="/delete-account">{t("supportDeleteAccount")}</Link>
        <Link href="https://github.com/OpenMapX/openmapx" rel="noreferrer">
          {t("supportSourceCode")}
        </Link>
      </Stack>
    </LegalPageShell>
  );
}
