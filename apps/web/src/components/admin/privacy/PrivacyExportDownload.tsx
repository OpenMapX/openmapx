"use client";
import { Alert, Button, Stack, Typography } from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { AdminReauthProofRef, PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { readStoredAdminReauthentication } from "@/lib/admin/adminReauthentication";
import {
  consumeDownloadToSink,
  createBlobSink,
  createFileSink,
  type DownloadSink,
  fileSinkSupported,
} from "@/lib/admin/downloadSink";
import type { PrivacyCaseClient } from "@/lib/admin/privacyAdmin";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";

/** True when this tab holds a sign-in ceremony for exporting this case, so
 * the dialog reopens after the administrator returns from signing in. */
function pendingCeremony(apiOrigin: string, requestId: string): boolean {
  const stored = readStoredAdminReauthentication(apiOrigin);
  return (
    stored?.requests.some(
      (request) => request.purpose === "privacy.export" && request.targetId === requestId,
    ) ?? false
  );
}

/**
 * Download the subject's export for an assisted case. A fresh, purpose-bound
 * administrator sign-in authorizes one download; the archive streams from the
 * server and is never stored there.
 */
export function PrivacyExportDownload({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const w = useTranslations("privacyAdmin.workflows");
  const requestId = detail.request.id;
  const [ceremony, setCeremony] = useState(() =>
    pendingCeremony(client.binding.apiOrigin, requestId),
  );
  const [state, setState] = useState<"idle" | "downloading" | "done" | "failed">("idle");
  const filename = `openmapx-data-export-${requestId.slice(0, 8)}.zip`;
  const download = async (proofs: AdminReauthProofRef[]) => {
    setCeremony(false);
    const proof = proofs[0];
    if (!proof) return;
    setState("downloading");
    let sink: DownloadSink;
    try {
      sink = fileSinkSupported()
        ? await createFileSink(filename)
        : createBlobSink(filename, "application/zip");
    } catch {
      setState("idle");
      return;
    }
    const abort = new AbortController();
    try {
      await consumeDownloadToSink({ sink, signal: abort.signal }, async (onByteChunk) => {
        sdk.unwrapAdminResponse(
          await sdk.exportPrivacyAdminCase(
            requestId,
            {},
            { "x-admin-reauth-proof": proof.challengeId },
            { client: client.binding.client, signal: abort.signal, timeoutMs: 600000, onByteChunk },
          ),
        );
      });
      setState("done");
      void client.refresh();
    } catch {
      setState("failed");
      void client.refresh();
    }
  };
  return (
    <Stack spacing={2}>
      <Typography variant="body2">{w("exportHelp")}</Typography>
      {!detail.capabilities.export && detail.capabilities.reasons.export && (
        <Alert severity="info">
          {w("exportUnavailable")} ({detail.capabilities.reasons.export})
        </Alert>
      )}
      {state === "done" && <Alert severity="success">{w("exportDownloaded")}</Alert>}
      {state === "failed" && <Alert severity="error">{w("exportFailed")}</Alert>}
      <Button
        variant="contained"
        disabled={!detail.capabilities.export || state === "downloading"}
        onClick={() => setCeremony(true)}
      >
        {w("downloadExport")}
      </Button>
      {ceremony && (
        <AdminReauthenticationDialog
          purpose="privacy.export"
          targetId={requestId}
          onCompleted={(proofs) => void download(proofs)}
          onClose={() => setCeremony(false)}
        />
      )}
    </Stack>
  );
}
