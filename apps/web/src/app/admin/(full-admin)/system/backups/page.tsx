import Stack from "@mui/material/Stack";
import type { Metadata } from "next";
import { BackupsPage } from "@/components/admin/services/BackupsPage";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
export const metadata: Metadata = { title: "Backups — Admin — OpenMapX" };
export default function Page() {
  return (
    <Stack sx={{ gap: 2 }}>
      <BackupsPage />
      <PlatformConfiguration scope="retention" />
    </Stack>
  );
}
