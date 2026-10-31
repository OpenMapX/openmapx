"use client";
import { Alert, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { type PrivacyCaseClient, privacyResult } from "@/lib/admin/privacyAdmin";
import {
  consumePrivacyDownload,
  createPrivacyFileSink,
  privacyDownloadCapability,
} from "@/lib/admin/privacyDownload";
import {
  clearPendingPrivacyAdminDelivery,
  readPendingPrivacyAdminDelivery,
  savePendingPrivacyAdminDelivery,
} from "@/lib/admin/privacyReauthentication";
export function PrivacyArtifactDelivery({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const t = useTranslations("privacyAdmin");
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("archives")}</Typography>
      {detail.artifacts.map((artifact) => (
        <Artifact key={artifact.id} artifact={artifact} detail={detail} client={client} />
      ))}
    </Stack>
  );
}
function Artifact({
  artifact,
  detail,
  client,
}: {
  artifact: PrivacyAdminDetail["artifacts"][number];
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const w = useTranslations("privacyAdmin.workflows");
  const [channel, setChannel] = useState<"assisted" | "representative">("assisted"),
    [reason, setReason] = useState(""),
    [capability, setCapability] = useState<Awaited<
      ReturnType<typeof privacyDownloadCapability>
    > | null>(null),
    [completed, setCompleted] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const owner = useRef({ active: true, controller: new AbortController() });
  const attempted = useRef(false);
  useEffect(() => {
    const token = { active: true, controller: new AbortController() };
    owner.current = token;
    void privacyDownloadCapability("artifact", detail.request.id, artifact.id, client.client).then(
      (value) => {
        if (token.active) setCapability(value);
      },
      () => {
        if (token.active) setNotice("downloadUnavailable");
      },
    );
    return () => {
      token.active = false;
      token.controller.abort();
    };
  }, [artifact.id, client.client, detail.request.id]);
  const pending = readPendingPrivacyAdminDelivery(client.binding.apiOrigin, client.binding.actorId);
  const resume =
    pending?.requestId === detail.request.id && pending.artifactId === artifact.id ? pending : null;
  const authorized =
    channel === "assisted"
      ? detail.capabilities.assistedDelivery
      : detail.capabilities.representativeDelivery;
  const available =
    artifact.state === "ready" &&
    !!artifact.expiresAt &&
    Date.parse(artifact.expiresAt) > Date.now() &&
    authorized;
  const start = async () => {
    const result = await client.execute("artifact-reauth-start", (c, h) =>
      privacyResult(
        sdk.startPrivacyAdminReauthentication(
          detail.request.id,
          artifact.id,
          { channel, reasonCode: reason },
          h,
          { client: c },
        ),
      ),
    );
    if (!result) return;
    try {
      savePendingPrivacyAdminDelivery({
        apiOrigin: client.binding.apiOrigin,
        actorId: client.binding.actorId,
        requestId: detail.request.id,
        artifactId: artifact.id,
        challengeId: result.challengeId,
        expiresAt: result.expiresAt,
        channel,
      });
      window.location.assign("/auth/privacy/admin");
    } catch {
      setNotice("resumeUnavailable");
    }
  };
  const complete = async () => {
    if (!resume) return;
    setChannel(resume.channel);
    const result = await client.execute("artifact-reauth-complete", (c, h) =>
      privacyResult(
        sdk.completePrivacyAdminReauthentication(
          detail.request.id,
          artifact.id,
          { challengeId: resume.challengeId },
          h,
          { client: c },
        ),
      ),
    );
    if (result) {
      setCompleted(true);
      clearPendingPrivacyAdminDelivery();
      attempted.current = false;
    }
  };
  const download = async () => {
    if (attempted.current || !completed || busy) return;
    const token = owner.current;
    setBusy(true);
    setNotice(null);
    let issued = false;
    try {
      const target = await privacyDownloadCapability(
        "artifact",
        detail.request.id,
        artifact.id,
        client.client,
      );
      if (!token.active) return;
      if (target.kind === "unavailable") {
        setNotice("downloadUnavailable");
        return;
      }
      const sink =
        target.kind === "sink"
          ? await createPrivacyFileSink(artifact.filename ?? "openmapx-data-export.zip")
          : null;
      if (!token.active) {
        await sink?.abort("case-changed");
        return;
      }
      attempted.current = true;
      issued = true;
      setCompleted(false);
      clearPendingPrivacyAdminDelivery();
      if (target.kind === "native") {
        window.location.assign(target.target.url);
        setNotice("browserOwnsDownload");
      } else if (sink) {
        await consumePrivacyDownload({
          kind: "artifact",
          requestId: detail.request.id,
          itemId: artifact.id,
          client: client.client,
          sink,
          signal: token.controller.signal,
        });
        if (token.active) setNotice("checkDeliveryStatus");
      }
    } catch {
      if (token.active) setNotice(issued ? "checkDeliveryStatus" : "downloadCanceled");
    } finally {
      if (token.active) {
        setBusy(false);
        if (issued) void client.refresh();
      }
    }
  };
  return (
    <Stack spacing={1} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Typography>
        {artifact.filename} · {artifact.state} · {artifact.plaintextBytes ?? "—"} B
      </Typography>
      <Typography>
        {w("expiresAt")}: {artifact.expiresAt ?? "—"}
      </Typography>
      {notice && <Alert severity="info">{w(notice)}</Alert>}
      {capability?.kind === "unavailable" && (
        <Alert severity="warning">
          {w("downloadUnavailable")} ({capability.reason})
        </Alert>
      )}
      {!available && <Alert severity="info">{w("artifactNotAuthorized")}</Alert>}
      <TextField
        select
        label={w("deliveryChannel")}
        value={channel}
        disabled={client.pending || busy || completed || !!resume}
        onChange={(e) => setChannel(e.target.value as typeof channel)}
      >
        <MenuItem value="assisted">{w("assisted")}</MenuItem>
        <MenuItem value="representative" disabled={!detail.capabilities.representativeDelivery}>
          {w("representative")}
        </MenuItem>
      </TextField>
      <TextField
        label={w("deliveryReason")}
        value={reason}
        disabled={client.pending || busy || completed || !!resume}
        onChange={(e) => setReason(e.target.value)}
      />
      {resume ? (
        <Button disabled={client.pending || busy || !available} onClick={() => void complete()}>
          {w("completeReauthentication")}
        </Button>
      ) : completed ? (
        <Button variant="contained" disabled={busy || !available} onClick={() => void download()}>
          {w("download")}
        </Button>
      ) : (
        <Button
          disabled={
            client.pending ||
            busy ||
            !available ||
            !reason ||
            !capability ||
            capability.kind === "unavailable"
          }
          onClick={() => void start()}
        >
          {w("startAssistedDelivery")}
        </Button>
      )}
    </Stack>
  );
}
