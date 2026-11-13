"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import {
  type ResolvedSetting,
  type SettingsEditorSection,
  type SettingsEditorText,
  SystemSettings,
} from "@/components/admin/settings/SystemSettings";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";

const STEP_IDS = ["operator", "notifications", "retention"] as const;

export function PrivacySetupPage() {
  const t = useTranslations("privacySetup");
  const field = useSearchParams()?.get("field");
  const sections = useMemo<SettingsEditorSection[]>(
    () => [
      {
        id: "operator",
        groupId: "legal",
        subgroupIds: ["operator", "contact", "hosting", "governance"],
        label: t("steps.operator.title"),
        description: t("steps.operator.description"),
        defaultExpanded: true,
      },
      {
        id: "retention",
        groupId: "legal",
        subgroupIds: ["retention", "sources"],
        label: t("steps.retention.title"),
        description: t("steps.retention.description"),
      },
    ],
    [t],
  );

  const editorText = useMemo<SettingsEditorText>(
    () => ({
      envOverrides: t("editor.envOverrides"),
      envOverrideHelp: (envVar) => t("editor.envOverrideHelp", { envVar }),
      envSecretValue: t("editor.envSecretValue"),
      showSecret: t("editor.showSecret"),
      hideSecret: t("editor.hideSecret"),
      databaseSource: t("editor.databaseSource"),
      save: (label) => t("editor.save", { label }),
      saved: (label) => t("editor.saved", { label }),
      saveFailed: t("editor.saveFailed"),
      invalidJson: t("editor.invalidJson"),
      sendTestEmail: t("editor.sendTestEmail"),
      testEmailSent: t("editor.testEmailSent"),
      testEmailFailed: t("editor.testEmailFailed"),
      loadFailed: t("editor.loadFailed"),
    }),
    [t],
  );

  const subgroupMeta = useMemo(
    () =>
      Object.fromEntries(
        [
          "operator",
          "contact",
          "hosting",
          "governance",
          "retention",
          "sources",
          "common",
          "emaillabs",
          "lettermint",
          "smtp",
        ].map((id) => [
          id,
          {
            label: t(`subgroups.${id}.label`),
            description: t(`subgroups.${id}.description`),
          },
        ]),
      ),
    [t],
  );

  const settingText = useCallback(
    (setting: ResolvedSetting) => ({
      label: t(`settings.${setting.key}.label`),
      description: t(`settings.${setting.key}.description`),
    }),
    [t],
  );

  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title={t("title")} subtitle={t("subtitle")} />
      <Alert severity="info">{t("intro")}</Alert>

      <Paper component="nav" aria-label={t("stepNavigation")} variant="outlined" sx={{ p: 1 }}>
        <Stack direction="row" useFlexGap sx={{ gap: 0.5, flexWrap: "wrap" }}>
          {STEP_IDS.map((id) => (
            <Button key={id} component="a" href={`#${id}`} size="small">
              {t(`steps.${id}.title`)}
            </Button>
          ))}
        </Stack>
      </Paper>

      <Paper id="notifications" variant="outlined" sx={{ p: 2 }}>
        <Typography component="h2" variant="subtitle1">
          {t("steps.notifications.title")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("notificationsOwner")}
        </Typography>
        <Button component={Link} href="/admin/settings/email">
          {t("openEmailSettings")}
        </Button>
      </Paper>

      <SystemSettings
        focusKey={field && /^[a-zA-Z0-9_-]{1,128}$/.test(field) ? field : undefined}
        sections={sections}
        showHeader={false}
        showTransfer={false}
        settingText={settingText}
        subgroupMeta={subgroupMeta}
        text={editorText}
      />
    </Stack>
  );
}
