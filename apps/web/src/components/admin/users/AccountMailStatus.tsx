"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AccountMailOutcome, AccountProvisioningResult } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";

export function AccountMailStatus({
  userId,
  initial,
}: {
  userId: string;
  initial?: AccountProvisioningResult;
}) {
  const t = useTranslations("adminUsers");
  const labels: Record<AccountMailOutcome, string> = {
    not_requested: t("mailNotRequested"),
    queued: t("mailQueued"),
    sent: t("mailSent"),
    failed: t("mailFailed"),
    unknown: t("mailUnknown"),
  };
  const scope = useAccountAdmin(),
    query = useQuery({
      queryKey: scope.keys.delivery(userId),
      queryFn: ({ signal }) => scope.client.delivery(userId, signal),
      enabled: !!scope.actorId,
      retry: false,
      refetchInterval: (query) => {
        const value = query.state.data?.latest;
        return value &&
          (value.verificationDelivery === "queued" || value.passwordSetupDelivery === "queued")
          ? 1000
          : false;
      },
    }),
    latest = query.data?.latest ?? initial;
  return (
    <Stack sx={{ gap: 1 }}>
      <Typography variant="subtitle2">{t("latestAdministrativeMailRequest")}</Typography>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>{t("refresh")}</Button>}
        >
          {t("deliveryStatusCouldNotBe")}
        </Alert>
      )}
      {latest ? (
        <>
          <Typography variant="body2">
            {t("verificationEmailStatus", { status: labels[latest.verificationDelivery] })}
          </Typography>
          <Typography variant="body2">
            {t("passwordSetupStatus", { status: labels[latest.passwordSetupDelivery] })}
          </Typography>
        </>
      ) : (
        <Typography variant="body2">
          {query.isPending ? t("checkingDeliveryStatus") : t("noAdministrativeMailRequestRecorded")}
        </Typography>
      )}
      <Typography variant="caption">{t("acceptanceByTheMailService")}</Typography>
    </Stack>
  );
}
