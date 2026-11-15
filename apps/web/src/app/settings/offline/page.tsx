import { getTranslations } from "next-intl/server";
import { SettingsPageBody, SettingsPageHeader } from "../SettingsPageHeader";
import { OfflineSettingsClient } from "./OfflineSettingsClient";

export default async function OfflineSettingsPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <SettingsPageHeader title={t("offline")} />
      <SettingsPageBody>
        <OfflineSettingsClient />
      </SettingsPageBody>
    </>
  );
}
