"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiNativeDownloadUnavailableError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { ArtifactImportPreview, TransferStage } from "@openmapx/core/ops";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAdminJobRegistration } from "@/lib/admin/adminJobEffects";
import {
  artifactFileSinkSupported,
  createArtifactFileSink,
  downloadArtifactToSink,
  uploadArtifactFile,
} from "@/lib/admin/artifactTransferClient";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { formatBytes } from "@/lib/storageFormat";
import { useActivityClient } from "../activity/activityQueries";

const key = () => `artifact-${crypto.randomUUID()}`;
export function ArtifactTransfersSection({ apiUrl }: { apiUrl: string }) {
  return <ArtifactTransfersView key={apiUrl} apiUrl={apiUrl} />;
}
function ArtifactTransfersView({ apiUrl }: { apiUrl: string }) {
  const { client } = useActivityClient(),
    qc = useQueryClient(),
    register = useAdminJobRegistration();
  const owner = useAdminMutationOwner(client, apiUrl),
    byteRequest = useRef<{ owner: typeof owner; controller: AbortController } | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ receivedBytes: number; state: string } | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState(""),
    [preview, setPreview] = useState<ArtifactImportPreview | null>(null);
  const scope = ["admin", "artifact-transfers", apiUrl] as const;
  useEffect(() => {
    const capturedOwner = owner;
    return () => {
      if (byteRequest.current?.owner === capturedOwner) byteRequest.current.controller.abort();
    };
  }, [owner]);
  const capabilities = useQuery({
    queryKey: [...scope, "capabilities"],
    retry: false,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(await sdk.getAdminArtifactTransferCapabilities({ client, signal })),
  });
  const stages = useQuery({
    queryKey: [...scope, "stages"],
    retry: false,
    refetchInterval: 5000,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(
        await sdk.listAdminArtifactTransfers({ limit: 50, offset: 0 }, { client, signal }),
      ),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: scope });
  const queued = (jobId: string, label: string) => {
    register({ client, apiUrl, jobId, onSettled: refresh });
    if (owner.active) {
      setMessage(`Queued ${label}. Track its result in Activity (${jobId}).`);
      void refresh();
    }
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (owner.active)
        setError(
          failure instanceof Error
            ? failure.message
            : "Artifact operation failed; inspect the retained stage before retrying.",
        );
    } finally {
      if (owner.active) setBusy(false);
    }
  };
  const upload = () =>
    run(async () => {
      if (!file) return;
      const capturedFile = file,
        controller = new AbortController();
      byteRequest.current = { owner, controller };
      try {
        const stage = sdk.unwrapAdminResponse(
          await sdk.createAdminArtifactTransfer(
            { purpose: "prepared-artifact", direction: "upload", declaredBytes: capturedFile.size },
            { "idempotency-key": key() },
            { client, signal: controller.signal },
          ),
        );
        await uploadArtifactFile({
          client,
          stageId: stage.stageId,
          file: capturedFile,
          signal: controller.signal,
          onProgress: (value) => {
            if (owner.active) setProgress(value);
          },
        });
        if (owner.active) {
          setFile(null);
          if (fileInput.current) fileInput.current.value = "";
          setMessage("Uploaded. Validate the retained bundle before previewing an import.");
          void refresh();
        }
      } finally {
        if (byteRequest.current?.controller === controller) byteRequest.current = null;
      }
    });
  const download = (stage: TransferStage) =>
    run(async () => {
      // Save picker is selected in the gesture before any network await. Native
      // same-origin targets preserve browser-owned attachment streaming.
      try {
        const target = await sdk.getDownloadAdminArtifactTransferContentTarget(stage.stageId, {
          client,
        });
        if (owner.active) {
          window.location.assign(target.url);
          setMessage(
            "Download handed to your browser. Use browser controls to monitor or cancel it.",
          );
        }
        return;
      } catch (failure) {
        if (!(failure instanceof ApiNativeDownloadUnavailableError)) throw failure;
      }
      if (!artifactFileSinkSupported())
        throw Error(
          "This connection requires a browser with a file-save sink. Reconnect through the same-origin admin panel or use the CLI.",
        );
      if (!owner.active) return;
      const sink = await createArtifactFileSink(),
        controller = new AbortController();
      byteRequest.current = { owner, controller };
      try {
        await downloadArtifactToSink({
          client,
          stageId: stage.stageId,
          sink,
          signal: controller.signal,
        });
        if (owner.active) setMessage("Download saved.");
      } finally {
        if (byteRequest.current?.controller === controller) byteRequest.current = null;
      }
    });
  const target = capabilities.data?.targets.find((item) => item.serviceId === selected);
  return (
    <Paper variant="outlined" sx={{ p: 2.5, minWidth: 0 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Prepared artifact transfers</Typography>
        <Typography variant="body2">
          Move prepared data between instances with matching runtime images. Consumers must be
          stopped. Import never starts them.
        </Typography>
        {capabilities.data && (
          <Typography variant="body2">
            Upload limit {formatBytes(capabilities.data.limits.maxUploadBytes)} · Expanded limit{" "}
            {formatBytes(capabilities.data.limits.maxExpandedBytes)} · Free space{" "}
            {capabilities.data.freeBytes === null
              ? "unavailable"
              : formatBytes(capabilities.data.freeBytes)}
          </Typography>
        )}
        {(capabilities.error || stages.error) && (
          <Alert severity="warning">
            Transfer status is unavailable. Retained work is preserved; refresh when the agent is
            reachable.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
            {error}
          </Alert>
        )}
        {message && (
          <Alert severity="info" sx={{ overflowWrap: "anywhere" }}>
            {message}
          </Alert>
        )}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button variant="outlined" component="label" disabled={busy}>
            Choose bundle
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".tar,.gz,.tgz,application/octet-stream"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setProgress(null);
              }}
            />
          </Button>
          <Button
            onClick={upload}
            disabled={
              busy ||
              !file ||
              (capabilities.data !== undefined &&
                file.size > capabilities.data.limits.maxUploadBytes)
            }
          >
            Upload bundle
          </Button>
          {busy && (
            <Button
              onClick={() => byteRequest.current?.controller.abort()}
              disabled={!byteRequest.current}
            >
              Cancel byte transfer
            </Button>
          )}
          <Button
            onClick={() => {
              void refresh();
            }}
            disabled={busy}
          >
            Refresh transfers
          </Button>
        </Stack>
        {file && (
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {file.name} · {formatBytes(file.size)}
          </Typography>
        )}
        {progress && (
          <>
            {progress.state === "uploading" && <LinearProgress variant="indeterminate" />}
            <Typography variant="body2">
              {formatBytes(progress.receivedBytes)} received · {progress.state}
            </Typography>
          </>
        )}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField
            select
            label="Export target"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            sx={{ minWidth: 180 }}
          >
            {(capabilities.data?.targets ?? []).map((item) => (
              <MenuItem key={item.serviceId} value={item.serviceId}>
                {item.serviceId}
              </MenuItem>
            ))}
          </TextField>
          <Button
            disabled={busy || !target?.available || !target.artifactFingerprint}
            onClick={() =>
              void run(async () => {
                if (!target?.artifactFingerprint) return;
                const accepted = sdk.unwrapAdminResponse(
                  await sdk.exportAdminArtifactTransfer(
                    {
                      serviceId: target.serviceId as
                        | "osrm"
                        | "tileserver"
                        | "otp"
                        | "pelias"
                        | "motis",
                      expectedArtifactFingerprint: target.artifactFingerprint,
                    },
                    { "idempotency-key": key() },
                    { client },
                  ),
                );
                queued(accepted.jobId, "export");
              })
            }
          >
            Queue export
          </Button>
        </Stack>
        {target?.reason && <Alert severity="warning">{target.reason}</Alert>}
        {!selected &&
          capabilities.data?.targets
            .filter((item) => !item.available)
            .map((item) => (
              <Typography variant="body2" key={item.serviceId}>
                {item.reason}
              </Typography>
            ))}
        {(stages.data?.items ?? []).map((stage) => (
          <Paper key={stage.stageId} variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              {stage.direction} · {stage.state} · {formatBytes(stage.bytes)} · {stage.stageId}
            </Typography>
            {stage.sha256 && (
              <Typography variant="caption" sx={{ display: "block", overflowWrap: "anywhere" }}>
                SHA-256 {stage.sha256}
              </Typography>
            )}
            <Typography variant="caption">
              Expires {new Date(stage.expiresAt).toLocaleString()} · cleanup {stage.cleanup}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              {stage.direction === "upload" && ["uploaded", "ready"].includes(stage.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const accepted = sdk.unwrapAdminResponse(
                        await sdk.validateAdminArtifactTransfer(
                          stage.stageId,
                          { "idempotency-key": key() },
                          { client },
                        ),
                      );
                      queued(accepted.jobId, "validation");
                    })
                  }
                >
                  Validate
                </Button>
              )}
              {stage.direction === "upload" && stage.state === "ready" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const value = sdk.unwrapAdminResponse(
                        await sdk.previewAdminArtifactImport(stage.stageId, { client }),
                      );
                      if (owner.active) setPreview(value);
                    })
                  }
                >
                  Preview import
                </Button>
              )}
              {stage.direction === "download" && stage.state === "ready" && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    void download(stage);
                  }}
                >
                  Download bundle
                </Button>
              )}
              <Button
                disabled={busy || ["uploading", "validating", "claimed"].includes(stage.state)}
                onClick={() =>
                  void run(async () => {
                    sdk.unwrapAdminResponse(
                      await sdk.deleteAdminArtifactTransfer(stage.stageId, { client }),
                    );
                    if (owner.active) void refresh();
                  })
                }
              >
                Delete stage
              </Button>
            </Stack>
          </Paper>
        ))}
        <Button component={Link} href="/admin/activity" sx={{ alignSelf: "start" }}>
          Open Activity
        </Button>
      </Stack>
      <Dialog
        open={preview !== null}
        onClose={() => {
          if (!busy) setPreview(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Confirm prepared artifact import</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography>
              Target: {preview?.serviceId} · region {preview?.region ?? "unspecified"}
            </Typography>
            <Typography>
              Archive {formatBytes(preview?.bytes ?? 0)} · additional space{" "}
              {formatBytes(preview?.requiredFreeBytes ?? 0)}
            </Typography>
            <Typography variant="body2">
              Credentials required: {preview?.requiredCredentials.join(", ") || "none"}
            </Typography>
            {preview?.blockers.map((blocker) => (
              <Alert key={blocker} severity="warning">
                {blocker}
              </Alert>
            ))}
            {preview?.runtimeImageMismatches.map((item) => (
              <Alert key={item.service} severity="warning">
                {item.service}: bundle {item.bundle}; local {item.local}
              </Alert>
            ))}
            <Typography variant="body2">
              Consumers stay stopped. A queued job is not a completed import; check Activity for the
              publication and hardlink result.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setPreview(null)}>
            Close
          </Button>
          <Button
            disabled={busy || !preview || preview.blockers.length > 0}
            onClick={() =>
              void run(async () => {
                if (!preview?.sha256) return;
                const accepted = sdk.unwrapAdminResponse(
                  await sdk.importAdminArtifactTransfer(
                    preview.stageId,
                    {
                      expectedSha256: preview.sha256,
                      previewFingerprint: preview.fingerprint,
                      expectedCurrentRevisionId: preview.currentRevisionId,
                    },
                    { "idempotency-key": key() },
                    { client },
                  ),
                );
                queued(accepted.jobId, "import");
                if (owner.active) setPreview(null);
              })
            }
          >
            Confirm import
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
