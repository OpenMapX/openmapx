import { getTranslations } from "next-intl/server";
import { SettingsPageBody, SettingsPageHeader } from "../SettingsPageHeader";
import { PreferencesClient } from "./PreferencesClient";

export default async function PreferencesSettingsPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <SettingsPageHeader title={t("preferencesTitle")} />
      <SettingsPageBody>
        <PreferencesClient />
      </SettingsPageBody>
    </>
  );
}
