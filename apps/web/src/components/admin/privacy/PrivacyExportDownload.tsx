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

type State = "idle" | "ready" | "downloading" | "done" | "failed";

/**
 * Download the subject's export for an assisted case. A fresh, purpose-bound
 * administrator sign-in authorizes one download; the archive streams from the
 * server and is never stored there.
 *
 * The sign-in leaves this page, so a file destination chosen before it would
 * be lost. Once the sign-in is verified, a separate **Save export** click opens
 * the file picker inside its own user gesture, as the picker requires.
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
  const [proof, setProof] = useState<AdminReauthProofRef | null>(null);
  const [state, setState] = useState<State>("idle");
  const [inBrowser, setInBrowser] = useState(false);
  const filename = `openmapx-data-export-${requestId.slice(0, 8)}.zip`;

  const save = async () => {
    if (!proof) return;
    let sink: DownloadSink | undefined;
    if (fileSinkSupported()) {
      try {
        // First await in this click: the picker still has its user gesture.
        sink = await createFileSink(filename);
      } catch {
        sink = undefined;
      }
    }
    if (!sink) {
      // No picker, or it was refused: the browser saves the archive once it
      // has arrived. Say so instead of silently starting over.
      setInBrowser(true);
      sink = createBlobSink(filename, "application/zip");
    }
    setState("downloading");
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
    } catch {
      setState("failed");
    } finally {
      setProof(null);
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
      {inBrowser && state !== "idle" && <Alert severity="info">{w("exportInBrowser")}</Alert>}
      {state === "done" && <Alert severity="success">{w("exportDownloaded")}</Alert>}
      {state === "failed" && <Alert severity="error">{w("exportFailed")}</Alert>}
      {state === "ready" && proof ? (
        <Button variant="contained" onClick={() => void save()}>
          {w("saveExport")}
        </Button>
      ) : (
        <Button
          variant="contained"
          disabled={!detail.capabilities.export || state === "downloading"}
          onClick={() => {
            setInBrowser(false);
            setCeremony(true);
          }}
        >
          {w("downloadExport")}
        </Button>
      )}
      {ceremony && (
        <AdminReauthenticationDialog
          purpose="privacy.export"
          targetId={requestId}
          onCompleted={(proofs) => {
            setCeremony(false);
            setProof(proofs[0] ?? null);
            setState(proofs[0] ? "ready" : "idle");
          }}
          onClose={() => setCeremony(false)}
        />
      )}
    </Stack>
  );
}
