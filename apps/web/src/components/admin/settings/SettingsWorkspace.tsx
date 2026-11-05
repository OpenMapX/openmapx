"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import type { SETTINGS_TOPICS } from "@/lib/admin/adminNavigation";
import { useAdminNavigationAccess } from "../shared/AdminNavigationContext";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { SystemSettings } from "./SystemSettings";

const GROUPS = {
  general: "general",
  authentication: "auth",
  email: "email",
  map: "map",
  "data-use": "policy",
};
export function SettingsWorkspace({ topic }: { topic: (typeof SETTINGS_TOPICS)[number] }) {
  const t = useTranslations("adminNavigation");
  const { selfHosted } = useAdminNavigationAccess();
  const params = useSearchParams();
  const field = params.get("field");
  return (
    <Stack sx={{ gap: 2, maxWidth: 800 }}>
      <AdminPageHeader
        title={t(`destinations.${topic}.label`)}
        subtitle={t(`destinations.${topic}.description`)}
      />
      {topic === "general" && (
        <Alert
          severity="info"
          action={
            selfHosted !== false ? (
              <Button component={Link} href="/admin/system/deployment">
                {t("destinations.deployment.label")}
              </Button>
            ) : undefined
          }
        >
          {t("applicationUrlHelp")}
        </Alert>
      )}
      <SystemSettings
        flatSections
        key={topic}
        showHeader={false}
        showTransfer={false}
        focusKey={field && /^[a-zA-Z0-9_-]{1,128}$/.test(field) ? field : undefined}
        sections={[
          {
            id: topic,
            groupId: GROUPS[topic],
            label: t(`destinations.${topic}.label`),
            defaultExpanded: true,
            includeTestEmail: topic === "email",
          },
        ]}
      />
      {topic === "data-use" && (
        <Button component={Link} href="/admin/privacy-setup" sx={{ alignSelf: "flex-start" }}>
          {t("privacyPolicyLink")}
        </Button>
      )}
    </Stack>
  );
}
export function LegacySettingsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(
      window.location.hash === "#backup-retention"
        ? "/admin/system/backups#backup-retention"
        : "/admin/settings/general",
    );
  }, [router]);
  return null;
}
