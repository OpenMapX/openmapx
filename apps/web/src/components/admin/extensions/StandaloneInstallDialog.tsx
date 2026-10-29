"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import * as sdk from "@openmapx/core/api-admin-sdk";
import {
  type StandaloneInstallInspection,
  type StandaloneInstallSource,
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
} from "@openmapx/core/api-contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAdminJobRegistration } from "@/lib/admin/adminJobEffects";
import { invalidateExtensionAdministration } from "@/lib/admin/extensionAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import {
  activityJobQueryOptions,
  hasUnresolvedJobObservation,
  useActivityClient,
} from "../activity/activityQueries";

const terminal = new Set(["success", "failed", "canceled"]);
export function StandaloneInstallDialog() {
  const { apiUrl } = useActivityClient();
  return <StandaloneInstallDialogContent key={apiUrl} />;
}
function StandaloneInstallDialogContent() {
  const { client, apiUrl } = useActivityClient(),
    owner = useAdminMutationOwner(client, apiUrl),
    register = useAdminJobRegistration(),
    qc = useQueryClient();
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<StandaloneInstallSource["kind"]>("source"),
    [url, setUrl] = useState(""),
    [ref, setRef] = useState(""),
    [sha, setSha] = useState(""),
    [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [inspection, setInspection] = useState<StandaloneInstallInspection | null>(null),
    [done, setDone] = useState(false),
    [expired, setExpired] = useState(false);
  const generation = useRef(0),
    running = useRef(false),
    upload = useRef<AbortController | null>(null),
    keys = useRef({ preview: crypto.randomUUID(), install: crypto.randomUUID() });
  const uploadedSource = useRef<{
    file: File;
    source: Extract<StandaloneInstallSource, { kind: "uploaded-artifact" }>;
  } | null>(null);
  const [observed, setObserved] = useState<{
    jobId: string;
    phase: "preview" | "install";
    generation: number;
    owner: typeof owner;
    source?: StandaloneInstallSource;
  } | null>(null);
  const active =
    observed?.owner === owner && observed.generation === generation.current ? observed : null;
  const query = useQuery({
    ...activityJobQueryOptions(client, apiUrl, active?.jobId, "application"),
    refetchInterval: (query) =>
      query.state.data &&
      terminal.has(query.state.data.status) &&
      !hasUnresolvedJobObservation(query.state.data.result)
        ? false
        : 1000,
  });
  const waiting = Boolean(
    active &&
      (!query.data ||
        !terminal.has(query.data.status) ||
        hasUnresolvedJobObservation(query.data.result)),
  );
  const reset = (preserveUpload = false) => {
    if (!preserveUpload) uploadedSource.current = null;
    generation.current++;
    setObserved(null);
    setInspection(null);
    setError(null);
    setDone(false);
    setExpired(false);
    keys.current = { preview: crypto.randomUUID(), install: crypto.randomUUID() };
  };
  const close = () => {
    upload.current?.abort();
    reset();
    setOpen(false);
  };
  useEffect(() => () => upload.current?.abort(), []);
  useEffect(() => {
    if (!inspection) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(inspection.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [inspection]);
  useEffect(() => {
    const job = query.data;
    if (
      !active ||
      job?.id !== active.jobId ||
      !owner.active ||
      !terminal.has(job.status) ||
      hasUnresolvedJobObservation(job.result)
    )
      return;
    if (job.status !== "success") {
      setError(
        job.error ?? "Operation did not complete successfully. Inspect Activity before retrying.",
      );
      return;
    }
    if (active.phase === "preview") {
      const parsed = standaloneInstallInspectionSchema.safeParse(job.result);
      const expected = active.source;
      if (
        !parsed.success ||
        !expected ||
        parsed.data.sourceKind !== expected.kind ||
        (expected.kind === "uploaded-artifact" &&
          (parsed.data.stageId !== expected.stageId ||
            parsed.data.archiveSha256 !== expected.expectedSha256)) ||
        (expected.kind === "artifact" && parsed.data.archiveSha256 !== expected.sha256) ||
        (expected.kind === "source" &&
          /^[a-f0-9]{40}$/.test(expected.ref ?? "") &&
          parsed.data.commit !== expected.ref)
      ) {
        setError("The inspection response could not be verified.");
        return;
      }
      setInspection(parsed.data);
    } else setDone(true);
  }, [query.data, active, owner]);
  const capture = () => {
    const current = generation.current;
    return () => owner.active && generation.current === current;
  };
  const accept = (
    jobId: string,
    phase: "preview" | "install",
    current: () => boolean,
    source?: StandaloneInstallSource,
  ) => {
    register({
      client,
      apiUrl,
      jobId,
      onSettled: () => invalidateExtensionAdministration(qc, apiUrl, "components"),
    });
    if (current()) setObserved({ jobId, phase, generation: generation.current, owner, source });
  };
  const review = async () => {
    if (running.current) return;
    if (inspection) reset(true);
    running.current = true;
    setBusy(true);
    setError(null);
    const current = capture();
    try {
      let source: StandaloneInstallSource;
      if (kind === "source")
        source = standaloneInstallSourceSchema.parse({
          kind,
          repository: url,
          ...(ref ? { ref } : {}),
        });
      else if (kind === "artifact")
        source = standaloneInstallSourceSchema.parse({ kind, url, sha256: sha });
      else {
        if (!file || file.size === 0 || file.size > 200 * 1024 ** 2)
          throw Error("Select a nonempty integration archive of at most 200 MiB.");
        if (uploadedSource.current?.file === file) source = uploadedSource.current.source;
        else {
          const controller = new AbortController();
          upload.current = controller;
          const stage = sdk.unwrapAdminResponse(
            await sdk.createAdminArtifactTransfer(
              { purpose: "integration-artifact", direction: "upload", declaredBytes: file.size },
              { "idempotency-key": `${keys.current.preview}.upload` },
              { client, signal: controller.signal },
            ),
          );
          const uploaded = sdk.unwrapAdminResponse(
            await sdk.uploadAdminArtifactTransferContent(stage.stageId, file, {
              client,
              signal: controller.signal,
            }),
          );
          upload.current = null;
          if (!current()) return;
          if (!uploaded.sha256) throw Error("Uploaded archive digest is unavailable.");
          source = { kind, stageId: stage.stageId, expectedSha256: uploaded.sha256 };
          uploadedSource.current = { file, source };
        }
      }
      const result = sdk.unwrapAdminResponse(
        await sdk.previewAdminStandaloneIntegration(
          { source },
          { "idempotency-key": keys.current.preview },
          { client },
        ),
      );
      accept(result.jobId, "preview", current, source);
    } catch (error) {
      if (current()) setError(error instanceof Error ? error.message : "Inspection failed");
    } finally {
      upload.current = null;
      running.current = false;
      if (owner.active) setBusy(false);
    }
  };
  const install = async () => {
    if (running.current || !inspection || expired || inspection.denials.length) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const current = capture();
    try {
      const result = sdk.unwrapAdminResponse(
        await sdk.installAdminStandaloneIntegration(
          {
            inspectionId: inspection.inspectionId,
            expectedContentDigest: inspection.contentDigest,
          },
          { "idempotency-key": keys.current.install },
          { client },
        ),
      );
      accept(result.jobId, "install", current);
    } catch (error) {
      if (current()) setError(error instanceof Error ? error.message : "Installation failed");
    } finally {
      running.current = false;
      if (owner.active) setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="outlined"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Install standalone integration
      </Button>
      <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>Install standalone integration</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, pt: 1 }}>
            <Alert severity="info">
              Community integrations are declarative. Executable code and package scripts are
              rejected.
            </Alert>
            <TextField
              select
              label="Install source"
              value={kind}
              disabled={busy || waiting}
              onChange={(event) => {
                reset();
                setKind(event.target.value as StandaloneInstallSource["kind"]);
              }}
            >
              <MenuItem value="source">Source repository</MenuItem>
              <MenuItem value="artifact">Artifact URL</MenuItem>
              <MenuItem value="uploaded-artifact">Upload archive</MenuItem>
            </TextField>
            {kind === "uploaded-artifact" ? (
              <Button component="label" variant="outlined" disabled={busy || waiting}>
                {file?.name ?? "Choose integration archive"}
                <input
                  hidden
                  type="file"
                  accept=".tar.gz,.tgz,.tar"
                  aria-label="Integration archive"
                  onChange={(event) => {
                    reset();
                    setFile(event.target.files?.[0] ?? null);
                  }}
                />
              </Button>
            ) : (
              <TextField
                label={kind === "source" ? "Repository HTTPS URL" : "Artifact HTTPS URL"}
                value={url}
                disabled={busy || waiting}
                onChange={(event) => {
                  reset();
                  setUrl(event.target.value);
                }}
              />
            )}
            {kind === "source" && (
              <TextField
                label="Branch, tag, or commit (optional)"
                value={ref}
                disabled={busy || waiting}
                onChange={(event) => {
                  reset();
                  setRef(event.target.value);
                }}
              />
            )}
            {kind === "artifact" && (
              <TextField
                label="Archive SHA-256"
                value={sha}
                disabled={busy || waiting}
                onChange={(event) => {
                  reset();
                  setSha(event.target.value);
                }}
              />
            )}
            {kind === "uploaded-artifact" && (
              <Typography variant="body2">
                Maximum archive and expanded content: 200 MiB each.
              </Typography>
            )}
            {inspection && (
              <Stack sx={{ gap: 1 }}>
                <Typography sx={{ fontWeight: 600 }}>
                  {inspection.integrationId} · {inspection.version}
                </Typography>
                {inspection.commit && (
                  <Typography sx={{ overflowWrap: "anywhere" }} variant="body2">
                    Resolved commit: {inspection.commit}
                  </Typography>
                )}
                <Typography sx={{ overflowWrap: "anywhere" }} variant="body2">
                  Content SHA-256: {inspection.contentDigest}
                </Typography>
                <Typography variant="body2">
                  This installs or replaces the standalone integration with this ID. Catalog
                  ownership is preserved.
                </Typography>
                {inspection.denials.map((denial) => (
                  <Alert key={denial} severity="error">
                    {denial}
                  </Alert>
                ))}
              </Stack>
            )}
            {expired && (
              <Alert severity="warning">Inspection expired. Review the source again.</Alert>
            )}
            {(busy || waiting) && (
              <Alert severity="info">
                {busy
                  ? "Submitting…"
                  : "Operation is running. You can close this dialog and follow it in Activity."}
              </Alert>
            )}
            {query.error && (
              <Alert severity="warning">
                Unable to observe the operation. Check Activity before retrying.
              </Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            {done && <Alert severity="success">Standalone integration installed.</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{done ? "Done" : "Close"}</Button>
          {!done && (
            <Button variant="contained" disabled={busy || waiting} onClick={() => void review()}>
              Review source
            </Button>
          )}
          {inspection && !done && (
            <Button
              variant="contained"
              disabled={busy || waiting || expired || inspection.denials.length > 0}
              onClick={() => void install()}
            >
              Install integration
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
