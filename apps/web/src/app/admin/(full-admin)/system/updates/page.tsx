import Stack from "@mui/material/Stack";
import { useTranslations } from "next-intl";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
import { SystemMaintenance } from "@/components/admin/system/SystemMaintenance";
export default function Page() {
  const t = useTranslations("adminPages");
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title={t("updates.title")} subtitle={t("updates.subtitle")} />
      <PlatformConfiguration scope="release" />
      <SystemMaintenance section="updates" showHeader={false} />
    </Stack>
  );
}
