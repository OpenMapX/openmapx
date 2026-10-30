"use client";
import { Alert, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentMediaTypeSchema,
  attachmentPurposeSchema,
} from "@openmapx/core/privacy";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { type PrivacyCaseClient, privacyResult } from "@/lib/admin/privacyAdmin";
import {
  consumePrivacyDownload,
  createPrivacyFileSink,
  privacyDownloadCapability,
} from "@/lib/admin/privacyDownload";
export async function privacyAttachmentBase64(file: File) {
  if (file.size > ATTACHMENT_MAX_BYTES) throw Error("ATTACHMENT_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let result = "";
  const chunk = 3 * 8192;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    result += btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunk)));
  }
  return result;
}
export function PrivacyAttachments({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const w = useTranslations("privacyAdmin.workflows");
  const [file, setFile] = useState<File | null>(null),
    [purpose, setPurpose] = useState<
      | "identity_evidence"
      | "representative_authority"
      | "processor_response"
      | "operator_supplement"
    >("identity_evidence"),
    [source, setSource] = useState(""),
    [redaction, setRedaction] = useState(""),
    [reviewReason, setReviewReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const owner = useRef({ active: true, controller: new AbortController() });
  useEffect(() => {
    const executing = { active: true, controller: new AbortController() };
    owner.current = executing;
    return () => {
      executing.active = false;
      executing.controller.abort();
    };
  }, []);
  const upload = async () => {
    if (!file || busy) return;
    const executing = owner.current;
    setBusy(true);
    setError(false);
    try {
      const mediaType = attachmentMediaTypeSchema.parse(file.type || "text/plain"),
        contentBase64 = await privacyAttachmentBase64(file);
      if (!executing.active) return;
      const result = await client.execute("attachment-upload", (c, h) =>
        privacyResult(
          sdk.uploadPrivacyAdminAttachment(
            detail.request.id,
            {
              version: detail.request.version,
              purpose,
              filename: file.name,
              mediaType,
              contentBase64,
              ...(["processor_response", "operator_supplement"].includes(purpose)
                ? { metadata: { source, ...(redaction ? { redactionCode: redaction } : {}) } }
                : {}),
            },
            h,
            { client: c },
          ),
        ),
      );
      if (result) setFile(null);
    } catch {
      if (executing.active) setError(true);
    } finally {
      if (executing.active) setBusy(false);
    }
  };
  const download = async (id: string, filename: string) => {
    const executing = owner.current;
    setBusy(true);
    setError(false);
    try {
      const capability = await privacyDownloadCapability(
        "attachment",
        detail.request.id,
        id,
        client.client,
      );
      if (!executing.active) return;
      if (capability.kind === "native") window.location.assign(capability.target.url);
      else if (capability.kind === "sink") {
        const sink = await createPrivacyFileSink(filename);
        if (!executing.active) {
          await sink.abort("case-changed");
          return;
        }
        await consumePrivacyDownload({
          kind: "attachment",
          requestId: detail.request.id,
          itemId: id,
          client: client.client,
          sink,
          signal: executing.controller.signal,
        });
      } else setError(true);
    } catch {
      if (executing.active) setError(true);
    } finally {
      if (executing.active) setBusy(false);
    }
  };
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{w("attachments")}</Typography>
      {error && <Alert severity="error">{w("attachmentFailed")}</Alert>}
      <Typography>{w("attachmentHelp")}</Typography>
      <TextField
        type="file"
        label={w("attachmentFile")}
        slotProps={{
          inputLabel: { shrink: true },
          htmlInput: { accept: ".pdf,.txt,.csv,.json,.png,.jpg,.jpeg" },
        }}
        disabled={busy || client.pending || !detail.capabilities.attachmentWrite}
        onChange={(e) => {
          const next = (e.target as HTMLInputElement).files?.[0] ?? null;
          setFile(next);
          setError(!!next && next.size > ATTACHMENT_MAX_BYTES);
        }}
      />
      <TextField
        select
        label={w("attachmentPurpose")}
        value={purpose}
        onChange={(e) => setPurpose(attachmentPurposeSchema.parse(e.target.value))}
      >
        {attachmentPurposeSchema.options.map((x) => (
          <MenuItem key={x} value={x}>
            {w(`purposes.${x}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={w("provenanceSource")}
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      <TextField
        label={w("redactionCode")}
        value={redaction}
        onChange={(e) => setRedaction(e.target.value)}
      />
      <Button
        disabled={
          busy ||
          client.pending ||
          !detail.capabilities.attachmentWrite ||
          !file ||
          file.size > ATTACHMENT_MAX_BYTES ||
          (["processor_response", "operator_supplement"].includes(purpose) && !source)
        }
        onClick={() => void upload()}
      >
        {w("uploadAttachment")}
      </Button>
      <TextField
        label={w("rightsReviewReason")}
        value={reviewReason}
        onChange={(e) => setReviewReason(e.target.value)}
      />
      {detail.attachments.map((a) => (
        <Stack
          key={a.id}
          spacing={1}
          sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}
        >
          <Typography>
            {a.filename} · {a.purpose} · {a.rightsReviewState} · {a.plaintextBytes} B
          </Typography>
          <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap" }} spacing={1}>
            <Button
              disabled={busy || client.pending || Date.parse(a.expiresAt) <= Date.now()}
              onClick={() => void download(a.id, a.filename)}
            >
              {w("download")}
            </Button>
            {["operator_supplement", "processor_response"].includes(a.purpose) &&
              (["approved", "rejected"] as const).map((decision) => (
                <Button
                  key={decision}
                  disabled={
                    busy || client.pending || !reviewReason || !detail.capabilities.attachmentWrite
                  }
                  onClick={() =>
                    void client.execute("attachment-review", (c, h) =>
                      privacyResult(
                        sdk.reviewPrivacyAdminAttachment(
                          detail.request.id,
                          a.id,
                          { version: detail.request.version, decision, reasonCode: reviewReason },
                          h,
                          { client: c },
                        ),
                      ),
                    )
                  }
                >
                  {w(decision)}
                </Button>
              ))}
            <Button
              color="error"
              disabled={busy || client.pending || !detail.capabilities.attachmentWrite}
              onClick={() =>
                void client.execute("attachment-delete", (c, h) =>
                  privacyResult(
                    sdk.deletePrivacyAdminAttachment(
                      detail.request.id,
                      a.id,
                      { version: detail.request.version },
                      h,
                      { client: c },
                    ),
                  ),
                )
              }
            >
              {w("deleteAttachment")}
            </Button>
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
