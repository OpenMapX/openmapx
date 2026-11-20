import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Stack from "@mui/material/Stack";
import { useTranslations } from "next-intl";
import { ComposePreview } from "@/components/admin/services/ComposePreview";
import { ServiceSelectionEditor } from "@/components/admin/services/ServiceSelectionEditor";
import { PlatformConfiguration } from "@/components/admin/settings/PlatformConfiguration";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
export default function Page() {
  const t = useTranslations("adminPages");
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title={t("deployment.title")} subtitle={t("deployment.subtitle")} />
      <ServiceSelectionEditor />
      <PlatformConfiguration scope="deployment" />
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary>{t("deployment.composeRecovery")}</AccordionSummary>
        <AccordionDetails>
          <ComposePreview />
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
