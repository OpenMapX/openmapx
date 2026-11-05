import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Stack from "@mui/material/Stack";
import { ComposePreview } from "@/components/admin/services/ComposePreview";
import { ServiceSelectionEditor } from "@/components/admin/services/ServiceSelectionEditor";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
export default function Page() {
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader
        title="Deployment"
        subtitle="Persistent service roots, public origin and host configuration"
      />
      <ServiceSelectionEditor />
      <PlatformConfiguration scope="deployment" />
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary>Compose and host recovery</AccordionSummary>
        <AccordionDetails>
          <ComposePreview />
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
