import Stack from "@mui/material/Stack";
import type { Metadata } from "next";
import { BackupsPage } from "@/components/admin/services/BackupsPage";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("backups");
}
export default function Page() {
  return (
    <Stack sx={{ gap: 2 }}>
      <BackupsPage />
      <PlatformConfiguration scope="retention" />
    </Stack>
  );
}
