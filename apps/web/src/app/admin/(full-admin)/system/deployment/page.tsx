import Stack from "@mui/material/Stack";
import { ComposePreview } from "@/components/admin/services/ComposePreview";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
export default function Page() {
  return (
    <Stack sx={{ gap: 2 }}>
      <PlatformConfiguration />
      <ComposePreview />
    </Stack>
  );
}
