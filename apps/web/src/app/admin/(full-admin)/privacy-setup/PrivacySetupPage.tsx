"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { PrivacyApprovalForm } from "@/components/admin/privacy/PrivacyApprovalForm";
import {
  PrivacyReadinessChecklist,
  type PrivacyReadinessReport,
} from "@/components/admin/privacy/PrivacyReadinessChecklist";
import {
  type ResolvedSetting,
  type SettingsEditorSection,
  type SettingsEditorText,
  SystemSettings,
} from "@/components/admin/settings/SystemSettings";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

const STEP_IDS = ["operator", "notifications", "retention", "reviews"] as const;

export function PrivacySetupPage() {
  const t = useTranslations("privacySetup");
  const env = useEnv();
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
        id: "notifications",
        groupId: "email",
        label: t("steps.notifications.title"),
        description: t("steps.notifications.description"),
        includeTestEmail: true,
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

  const readiness = useQuery<PrivacyReadinessReport>({
    queryKey: ["privacy", "admin", "readiness", env.apiUrl],
    queryFn: async () => {
      const response = await fetch(`${env.apiUrl}/api/privacy/admin/readiness`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("readiness unavailable");
      return response.json();
    },
  });

  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title={t("title")} subtitle={t("subtitle")} />
      <Alert severity="info">{t("intro")}</Alert>

      <Paper component="nav" aria-label={t("stepNavigation")} variant="outlined" sx={{ p: 1 }}>
        <Stack direction="row" useFlexGap sx={{ gap: 0.5, flexWrap: "wrap" }}>
          {STEP_IDS.map((id, index) => (
            <Button key={id} component={Link} href={`#${id}`} size="small">
              {t("stepLink", { number: index + 1, title: t(`steps.${id}.title`) })}
            </Button>
          ))}
        </Stack>
      </Paper>

      <SystemSettings
        sections={sections}
        showHeader={false}
        showTransfer={false}
        settingText={settingText}
        subgroupMeta={subgroupMeta}
        text={editorText}
        onSettingsSaved={async () => {
          await readiness.refetch();
        }}
      />

      <Paper id="reviews" variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Stack sx={{ gap: 1.5 }}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            useFlexGap
            sx={{ gap: 1, alignItems: { sm: "flex-start" } }}
          >
            <Stack sx={{ flex: 1, gap: 0.25 }}>
              <Typography component="h2" variant="h6">
                {t("steps.reviews.title")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("steps.reviews.description")}
              </Typography>
            </Stack>
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              disabled={readiness.isFetching}
              onClick={() => void readiness.refetch()}
            >
              {t("readiness.refresh")}
            </Button>
          </Stack>

          {readiness.isLoading ? (
            <Stack sx={{ gap: 1 }}>
              {[1, 2, 3].map((item) => (
                <Skeleton key={item} variant="rounded" height={72} />
              ))}
            </Stack>
          ) : readiness.data ? (
            <PrivacyReadinessChecklist readiness={readiness.data} canConfigure />
          ) : (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void readiness.refetch()}>
                  {t("readiness.retry")}
                </Button>
              }
            >
              {t("readiness.loadFailed")}
            </Alert>
          )}
          {readiness.data && (
            <>
              <Divider />
              <Stack sx={{ gap: 0.25 }}>
                <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("approval.title")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("approval.description")}
                </Typography>
              </Stack>
              <PrivacyApprovalForm
                evidenceVersion={readiness.data.evidenceVersion}
                onRecorded={async () => {
                  await readiness.refetch();
                }}
              />
            </>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
