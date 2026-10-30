"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { formatBytes } from "@/lib/storageFormat";
import { useActivityClient } from "../activity/activityQueries";
import { useAdminToast } from "../shared/AdminToast";

type Preview = Extract<
  Awaited<ReturnType<typeof sdk.previewAdminBackupPrune>>,
  { status: 200 }
>["data"];
export function BackupPruneControls() {
  const { client, apiUrl } = useActivityClient(),
    owner = useAdminMutationOwner(client),
    register = useServiceJobRegistration(),
    showToast = useAdminToast();
  const [intent, setIntent] = useState<{ preview: Preview; idempotencyKey: string } | null>(null),
    [confirmation, setConfirmation] = useState("");
  const [, tick] = useState(0);
  const expiresAt = intent?.preview.proof.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.max(0, Date.parse(expiresAt) - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const previewMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const execution = owner;
      const preview = sdk.unwrapAdminResponse(await sdk.previewAdminBackupPrune({ client }));
      if (execution.active) {
        setIntent({ preview, idempotencyKey: crypto.randomUUID() });
        setConfirmation("");
      }
    },
  });
  const pruneMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!intent || Date.parse(intent.preview.proof.expiresAt) <= Date.now())
        throw Error("Preview expired; request a fresh preview");
      const execution = owner;
      const result = sdk.unwrapAdminResponse(
        await sdk.pruneAdminServiceBackups(
          { proof: intent.preview.proof, confirmation: "PRUNE EXPIRED BACKUPS" },
          { "idempotency-key": intent.idempotencyKey },
          { client },
        ),
      );
      register({ client, apiUrl, jobId: result.jobId, effect: { kind: "backups" } });
      if (execution.active) {
        setIntent(null);
        showToast(`Backup prune queued (${result.jobId})`);
      }
    },
  });
  const expired = !!expiresAt && Date.parse(expiresAt) <= Date.now();
  return (
    <Stack sx={{ gap: 1 }}>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        <Button
          variant="outlined"
          disabled={previewMutation.isPending || pruneMutation.isPending}
          onClick={() => {
            pruneMutation.reset();
            previewMutation.mutate();
          }}
        >
          Preview expired backups
        </Button>
        <Button component={Link} href="/admin/settings#backup-retention">
          Edit backup retention policy
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        A longer policy applies to new backups. Existing expiry ceilings cannot be extended.
      </Typography>
      {previewMutation.isError && (
        <Alert severity="error">
          Backup preview is unavailable. Retry after checking Activity.
        </Alert>
      )}
      <Dialog
        open={intent !== null}
        onClose={pruneMutation.isPending ? undefined : () => setIntent(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Prune expired backups</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, pt: 1 }}>
            <Typography>
              {intent?.preview.retentionDays} days · {intent?.preview.policySource} policy
            </Typography>
            <Typography>
              Eligible backups: {intent?.preview.candidates.length} (
              {formatBytes(
                intent?.preview.candidates.reduce((sum, item) => sum + item.totalBytes, 0) ?? 0,
              )}
              ); retained: {intent?.preview.retainedCount}.
            </Typography>
            <Stack sx={{ maxHeight: 240, overflowY: "auto" }}>
              {intent?.preview.candidates.map((entry) => (
                <Typography key={entry.backupId} variant="body2">
                  {entry.backupId}
                  {entry.corrupt ? " · unreadable expiry metadata, directory age used" : ""}
                </Typography>
              ))}
            </Stack>
            {!!intent?.preview.corruptBackups.length && (
              <Alert severity="warning">
                Unreadable expiry metadata: {intent.preview.corruptBackups.join(", ")}. Review these
                entries before confirming.
              </Alert>
            )}
            {expired && (
              <Alert severity="warning">Preview expired. Cancel and request a fresh preview.</Alert>
            )}
            {pruneMutation.isError && (
              <Alert severity="error">
                Prune request failed. Inspect Activity, then retry this same request or obtain a
                fresh preview if the inventory or policy changed.
              </Alert>
            )}
            <TextField
              label="Confirmation"
              helperText="Type PRUNE EXPIRED BACKUPS"
              value={confirmation}
              disabled={pruneMutation.isPending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={pruneMutation.isPending} onClick={() => setIntent(null)}>
            Cancel
          </Button>
          <Button
            color="error"
            disabled={
              pruneMutation.isPending ||
              expired ||
              !intent?.preview.candidates.length ||
              confirmation !== "PRUNE EXPIRED BACKUPS"
            }
            onClick={() => pruneMutation.mutate()}
          >
            Prune backups
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
