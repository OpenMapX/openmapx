"use client";

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

/**
 * The top of the integration list while the API runs in safe mode: why, the
 * integration automatic safe mode blames when it knows one, and the way out.
 * Safe mode the environment forces cannot be left here, so it gets no button.
 */
export function SafeModeNotice() {
  const t = useTranslations("adminIntegrations");
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client);
  const showToast = useAdminToast();
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);

  const { data: state } = useQuery(admin.queries.safeMode());
  const { data: integrations } = useQuery({
    ...admin.queries.list(),
    enabled: state?.reason === "automatic" && state.integrationId !== null,
  });

  const leave = useMutation({
    mutationKey: ["integration-safe-mode-leave", admin.apiUrl],
    retry: false,
    mutationFn: () => admin.leaveSafeMode(),
    onSuccess: () => {
      void admin.refresh();
      if (!owner.active) return;
      setConfirming(false);
      showToast(t("leftSafeMode"));
    },
    onError: (error) => {
      // The API may have left safe mode before its reload failed; read the
      // state and the list again so neither shows safe mode that is gone.
      void admin.refresh();
      if (!owner.active) return;
      setConfirming(false);
      showToast(adminErrorText(error, t("leaveSafeModeFailed")), "error");
    },
  });

  if (!state?.active) return null;

  const blamed = state.integrationId;
  const name =
    blamed === null
      ? null
      : (integrations?.find((integration) => integration.id === blamed)?.name ?? blamed);
  // Automatic safe mode does not always know which integration was loading.
  const reason =
    state.reason === "env"
      ? t("safeModeReasonEnv")
      : state.reason === "automatic"
        ? name === null
          ? t("safeModeReasonAutomaticUnnamed")
          : t("safeModeReasonAutomatic", { name })
        : t("safeModeReasonOperator");
  const next =
    state.reason === "env"
      ? t("safeModeEnvFix")
      : state.reason === "automatic"
        ? name === null
          ? t("safeModeAutomaticFixUnnamed")
          : t("safeModeAutomaticFix", { name })
        : null;

  return (
    <>
      <Alert
        role="region"
        aria-labelledby={titleId}
        severity="warning"
        variant="outlined"
        sx={{ "& .MuiAlert-message": { minWidth: 0, overflowWrap: "anywhere" } }}
      >
        <AlertTitle id={titleId}>{t("safeModeTitle")}</AlertTitle>
        <Stack sx={{ gap: 0.75, alignItems: "flex-start" }}>
          <Typography variant="body2">{reason}</Typography>
          {next && <Typography variant="body2">{next}</Typography>}
          {/* Below the text, so it keeps its width on a narrow screen. */}
          {state.reason !== "env" && (
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              disabled={leave.isPending}
              startIcon={leave.isPending ? <CircularProgress size={14} color="inherit" /> : null}
              onClick={() => setConfirming(true)}
              sx={{ mt: 0.5 }}
            >
              {t("leaveSafeMode")}
            </Button>
          )}
        </Stack>
      </Alert>
      <ConfirmDialog
        open={confirming}
        title={t("leaveSafeModeTitle")}
        message={t("leaveSafeModeMessage")}
        confirmLabel={t("leaveSafeMode")}
        confirmColor="warning"
        loading={leave.isPending}
        onConfirm={() => leave.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
