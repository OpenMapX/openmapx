import Stack from "@mui/material/Stack";
import type { Metadata } from "next";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
import { SystemSettings } from "@/components/admin/settings/SystemSettings";

export const metadata: Metadata = { title: "Settings — Admin — OpenMapX" };

export default function AdminSettingsPage() {
  return (
    <Stack sx={{ gap: 3 }}>
      <PlatformConfiguration />
      <SystemSettings />
    </Stack>
  );
}
