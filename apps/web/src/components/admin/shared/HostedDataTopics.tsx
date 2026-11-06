"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AdminPageHeader } from "./AdminPageHeader";
export function HostedDataTopics({ showHeader = true }: { showHeader?: boolean }) {
  const t = useTranslations("adminNavigation");
  return (
    <Stack sx={{ gap: 2 }}>
      {showHeader && <AdminPageHeader title={t("primary.data")} />}
      <Alert severity="info">{t("hostedData")}</Alert>
      <Stack direction="row" sx={{ gap: 1 }}>
        <Button component={Link} href="/admin/data/transit">
          {t("destinations.transit.label")}
        </Button>
        <Button component={Link} href="/admin/data/coverage">
          {t("destinations.coverage.label")}
        </Button>
      </Stack>
    </Stack>
  );
}
