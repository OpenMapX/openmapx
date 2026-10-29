"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import * as sdk from "@openmapx/core/api-admin-sdk";
import {
  type StandaloneInventoryEntry,
  standaloneInventoryEntrySchema,
} from "@openmapx/core/api-contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAdminJobRegistration } from "@/lib/admin/adminJobEffects";
import { invalidateExtensionAdministration } from "@/lib/admin/extensionAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import {
  activityJobQueryOptions,
  hasUnresolvedJobObservation,
  useActivityClient,
} from "../activity/activityQueries";

export function StandaloneIntegrationsPanel() {
  const { apiUrl } = useActivityClient();
  return <LocalInstallations key={apiUrl} />;
}
function LocalInstallations() {
  const { client, apiUrl } = useActivityClient(),
    owner = useAdminMutationOwner(client, apiUrl),
    register = useAdminJobRegistration(),
    qc = useQueryClient(),
    key = useMemo(() => ["admin", "standalone-integrations", apiUrl] as const, [apiUrl]);
  const [selected, setSelected] = useState<{
      entry: StandaloneInventoryEntry;
      action: "adopt" | "remove";
      key: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [accepted, setAccepted] = useState<{ jobId: string; operationId: string } | null>(null),
    [success, setSuccess] = useState(false);
  const inventory = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const data = sdk.unwrapAdminResponse(
        await sdk.listAdminStandaloneIntegrations({ client, signal, timeoutMs: 60000 }),
      );
      return data.entries.map((entry) => standaloneInventoryEntrySchema.parse(entry));
    },
  });
  const operation = useQuery({
    ...activityJobQueryOptions(client, apiUrl, accepted?.jobId, "application"),
    refetchInterval: (q) =>
      q.state.data &&
      ["success", "failed", "canceled"].includes(q.state.data.status) &&
      !hasUnresolvedJobObservation(q.state.data.result)
        ? false
        : 1000,
  });
  const pending =
    !!accepted &&
    (!operation.data ||
      !["success", "failed", "canceled"].includes(operation.data.status) ||
      hasUnresolvedJobObservation(operation.data.result));
  useEffect(() => {
    const job = operation.data;
    if (
      !owner.active ||
      !accepted ||
      job?.id !== accepted.jobId ||
      !["success", "failed", "canceled"].includes(job.status) ||
      hasUnresolvedJobObservation(job.result)
    )
      return;
    if (job.status === "success") {
      const result = job.result as {
        operationId?: unknown;
        integrationId?: unknown;
        action?: unknown;
        outcome?: unknown;
      } | null;
      if (
        !selected ||
        result?.operationId !== accepted.operationId ||
        result.integrationId !== selected.entry.integrationId ||
        result.action !== selected.action ||
        result.outcome !== "committed"
      ) {
        setError("The ownership response could not be verified. Inspect Activity.");
        return;
      }
      setSuccess(true);
      void qc.invalidateQueries({ queryKey: key });
      void invalidateExtensionAdministration(qc, apiUrl, "components");
    } else setError(job.error ?? "Operation did not complete. Inspect Activity before retrying.");
  }, [operation.data, accepted, owner, selected, qc, apiUrl, key]);
  const open = (entry: StandaloneInventoryEntry, action: "adopt" | "remove") => {
    setSelected({ entry, action, key: crypto.randomUUID() });
    setAccepted(null);
    setError(null);
    setSuccess(false);
  };
  const submit = async () => {
    if (
      !selected ||
      (selected.action === "adopt" && !selected.entry.contentDigest) ||
      busy ||
      accepted
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = sdk.unwrapAdminResponse(
        await (selected.action === "adopt"
          ? sdk.adoptAdminStandaloneIntegration(
              selected.entry.integrationId,
              { expectedContentDigest: selected.entry.contentDigest! },
              { "idempotency-key": selected.key },
              { client, timeoutMs: 30000 },
            )
          : sdk.removeAdminStandaloneIntegration(
              selected.entry.integrationId,
              { expectedContentDigest: selected.entry.contentDigest },
              { "idempotency-key": selected.key },
              { client, timeoutMs: 30000 },
            )),
      );
      register({
        client,
        jobId: result.jobId,
        apiUrl,
        onSettled: async () => {
          await qc.invalidateQueries({ queryKey: key });
          await invalidateExtensionAdministration(qc, apiUrl, "components");
        },
      });
      if (owner.active) setAccepted(result);
    } catch (error) {
      if (owner.active)
        setError(
          sdk.adminErrorMessage(
            error,
            "Submission was not confirmed. Retry uses the same operation key; inspect Activity if uncertain.",
          ),
        );
    } finally {
      if (owner.active) setBusy(false);
    }
  };
  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="h6">Local integrations</Typography>
        <Button onClick={() => void inventory.refetch()}>Refresh local inventory</Button>
      </Stack>
      <Typography variant="body2">
        Manage standalone and CLI-installed integrations independently of catalog availability.
        Adoption records community trust and does not download or execute code.
      </Typography>
      {inventory.isPending && <CircularProgress size={24} />}
      {inventory.error && (
        <Alert severity="error">
          Local inventory is unavailable. Existing work may still be running; inspect Activity
          before retrying.
        </Alert>
      )}
      {inventory.data?.length === 0 && <Alert severity="info">No local integrations found.</Alert>}
      {inventory.data?.map((entry) => (
        <Card key={entry.integrationId} variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography sx={{ overflowWrap: "anywhere" }} variant="subtitle1">
                {entry.integrationId}
              </Typography>
              <Typography variant="body2">
                Version: {entry.version ?? "unknown"} · Ownership: {entry.ownership}
              </Typography>
              <Typography variant="body2">
                {entry.provenance === "legacy_unknown"
                  ? "Source unknown; review a new source to update."
                  : `Source: ${entry.provenance}`}
              </Typography>
              {entry.contentDigest && (
                <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                  Content SHA-256: {entry.contentDigest}
                </Typography>
              )}
              {entry.denialReason && <Alert severity="warning">{entry.denialReason}</Alert>}
              {entry.pendingTransactionId && (
                <Button component={Link} href="/admin/activity">
                  Inspect original Activity
                </Button>
              )}
              <Stack direction="row" spacing={1}>
                {entry.adoptable && (
                  <Button
                    aria-label={`Adopt ${entry.integrationId}`}
                    onClick={() => open(entry, "adopt")}
                  >
                    Adopt
                  </Button>
                )}
                {entry.removable && (
                  <Button
                    color="error"
                    aria-label={`Remove ${entry.integrationId}`}
                    onClick={() => open(entry, "remove")}
                  >
                    Remove
                  </Button>
                )}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      ))}
      <Dialog
        open={!!selected}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {selected?.action === "adopt" ? "Adopt local integration" : "Remove local integration"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography sx={{ overflowWrap: "anywhere" }}>
              {selected?.entry.integrationId}
            </Typography>
            <Typography>
              {selected?.action === "adopt"
                ? "Record the reviewed local bytes under a standalone community owner. Their original source remains unknown."
                : "Quarantine the reviewed directory, reload the instance, then remove its ownership records. An uncertain result remains held for reconciliation."}
            </Typography>
            <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
              Content SHA-256: {selected?.entry.contentDigest}
            </Typography>
            {(busy || pending) && (
              <Alert severity="info">
                {busy
                  ? "Submitting…"
                  : "Operation is running or awaiting reconciliation. Follow its original job in Activity."}
              </Alert>
            )}
            {operation.error && accepted && (
              <Alert severity="warning">
                Unable to observe the original operation. Check Activity; this does not cancel it.
              </Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">Ownership change completed.</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelected(null)} disabled={busy}>
            Close
          </Button>
          {!accepted && (
            <Button
              variant="contained"
              color={selected?.action === "remove" ? "error" : "primary"}
              disabled={busy}
              onClick={() => void submit()}
            >
              {selected?.action === "adopt" ? "Confirm adoption" : "Confirm removal"}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
