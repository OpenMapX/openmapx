"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AccountMailOutcome, AccountProvisioningResult } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";

const labels: Record<AccountMailOutcome, string> = {
  not_requested: "Not requested",
  queued: "Queued",
  sent: "Accepted by mail service",
  failed: "Mail handoff failed",
  unknown: "Outcome unknown — check with the recipient before resending",
};
export function AccountMailStatus({
  userId,
  initial,
}: {
  userId: string;
  initial?: AccountProvisioningResult;
}) {
  const scope = useAccountAdmin(),
    query = useQuery({
      queryKey: scope.keys.delivery(userId),
      queryFn: () => scope.client.delivery(userId),
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
      <Typography variant="subtitle2">Latest administrative mail request</Typography>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>Refresh</Button>}
        >
          Delivery status could not be refreshed.
        </Alert>
      )}
      {latest ? (
        <>
          <Typography variant="body2">
            Verification email: {labels[latest.verificationDelivery]}
          </Typography>
          <Typography variant="body2">
            Password setup: {labels[latest.passwordSetupDelivery]}
          </Typography>
        </>
      ) : (
        <Typography variant="body2">
          {query.isPending
            ? "Checking delivery status…"
            : "No administrative mail request recorded."}
        </Typography>
      )}
      <Typography variant="caption">
        Acceptance by the mail service does not confirm recipient delivery. An unknown send is never
        retried automatically.
      </Typography>
    </Stack>
  );
}
