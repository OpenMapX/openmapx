"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useTranslations } from "next-intl";

export interface PrivacyReadinessReport {
  ready: boolean;
  checkedAt: string;
  evidenceVersion: string;
  checks: Array<{ id: string; status: string; detailCode: string }>;
}

const CHECK_ACTIONS: Record<string, string> = {
  "controller-contact": "/admin/privacy-setup#operator",
  "notification-health": "/admin/privacy-setup#notifications",
  "cleanup-retention": "/admin/privacy-setup#retention",
  "registry-completeness": "/admin/privacy-setup#retention",
  "encryption-key": "/admin/system",
  "artifact-storage": "/admin/system",
  "artifact-storage-backup": "/admin/services/backups",
  "backup-review-capability": "/admin/services/backups",
  "request-sla-monitor": "/admin/system",
  "preservation-enforcement": "/admin/privacy-setup#reviews",
  "source-streaming": "/admin/privacy-setup#reviews",
  "assisted-workflow": "/admin/privacy-setup#reviews",
  translations: "/admin/privacy-setup#reviews",
  openapi: "/admin/privacy-setup#reviews",
  policy: "/admin/privacy-setup#reviews",
  "approval-legal-content": "/admin/privacy-setup#reviews",
  "approval-dsar-process": "/admin/privacy-setup#reviews",
  "approval-security-review": "/admin/privacy-setup#reviews",
};

const KNOWN_CHECKS = new Set(Object.keys(CHECK_ACTIONS));

function statusColor(status: string): "success" | "warning" | "error" {
  if (status === "pass") return "success";
  if (status === "warning") return "warning";
  return "error";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "pass") return <CheckCircleIcon color="success" />;
  if (status === "warning") return <WarningAmberIcon color="warning" />;
  return <ErrorIcon color="error" />;
}

export function PrivacyReadinessChecklist({
  readiness,
  canConfigure,
}: {
  readiness: PrivacyReadinessReport;
  canConfigure: boolean;
}) {
  const t = useTranslations("privacySetup");
  const needsAction = readiness.checks.some((check) => check.status !== "pass");

  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack direction="row" useFlexGap sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <StatusIcon status={readiness.ready ? "pass" : "fail"} />
        <Typography sx={{ fontWeight: 650 }}>
          {readiness.ready ? t("readiness.ready") : t("readiness.notReady")}
        </Typography>
        <Chip size="small" variant="outlined" label={readiness.evidenceVersion} />
      </Stack>

      {!canConfigure && needsAction && (
        <Alert severity="info">{t("readiness.contactFullAdmin")}</Alert>
      )}

      <List disablePadding sx={{ display: "grid", gap: 1 }}>
        {readiness.checks.map((check) => {
          const known = KNOWN_CHECKS.has(check.id);
          const copyBase = known ? `readiness.checks.${check.id}` : "readiness.unknown";
          const actionHref = CHECK_ACTIONS[check.id];
          return (
            <ListItem
              key={check.id}
              disableGutters
              sx={{
                alignItems: "flex-start",
                gap: 1.25,
                p: 1.25,
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
              }}
            >
              <Box sx={{ pt: 0.25 }}>
                <StatusIcon status={check.status} />
              </Box>
              <Stack sx={{ flex: 1, minWidth: 0, gap: 0.5 }}>
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  useFlexGap
                  sx={{ alignItems: { sm: "center" }, gap: 0.75 }}
                >
                  <Typography sx={{ flex: 1, fontWeight: 650 }}>
                    {t(`${copyBase}.title`)}
                  </Typography>
                  <Chip
                    size="small"
                    color={statusColor(check.status)}
                    variant="outlined"
                    label={
                      check.status === "pass"
                        ? t("readiness.status.pass")
                        : check.status === "warning"
                          ? t("readiness.status.warning")
                          : t("readiness.status.fail")
                    }
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t(`${copyBase}.description`)}
                </Typography>
                {canConfigure && check.status !== "pass" && actionHref && known && (
                  <Box>
                    <Button component={Link} href={actionHref} size="small" sx={{ px: 0.5 }}>
                      {t(`${copyBase}.action`)}
                    </Button>
                  </Box>
                )}
                <Box
                  component="details"
                  sx={{
                    color: "text.secondary",
                    "& summary": { cursor: "pointer", fontSize: 12 },
                  }}
                >
                  <Typography component="summary" variant="caption">
                    {t("readiness.technicalDetails")}
                  </Typography>
                  <Typography
                    component="div"
                    variant="caption"
                    sx={{ mt: 0.5, fontFamily: "monospace", overflowWrap: "anywhere" }}
                  >
                    {check.id}
                    <br />
                    {check.detailCode}
                  </Typography>
                </Box>
              </Stack>
            </ListItem>
          );
        })}
      </List>
    </Stack>
  );
}
