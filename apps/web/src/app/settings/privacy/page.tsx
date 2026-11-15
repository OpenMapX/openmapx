import { getTranslations } from "next-intl/server";
import { PrivacyDataSection } from "@/components/auth/PrivacyDataSection";
import { SettingsPageBody, SettingsPageHeader } from "../SettingsPageHeader";

export default async function PrivacySettingsPage() {
  const t = await getTranslations("account.privacyData");
  return (
    <>
      <SettingsPageHeader title={t("title")} />
      <SettingsPageBody>
        <PrivacyDataSection showTitle={false} />
      </SettingsPageBody>
    </>
  );
}
