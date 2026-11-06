import Stack from "@mui/material/Stack";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
import { SystemMaintenance } from "@/components/admin/system/SystemMaintenance";
export default function Page() {
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title="Updates" subtitle="Select, check and apply an OpenMapX release" />
      <PlatformConfiguration scope="release" />
      <SystemMaintenance section="updates" showHeader={false} />
    </Stack>
  );
}
