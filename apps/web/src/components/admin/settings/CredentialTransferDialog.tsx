"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  applyAdminCredentialTransfer,
  chooseAdminCredentialTransferFields,
  exportAdminCredentialTransfer,
  getAdminTransitCredentials,
  previewAdminCredentialTransfer,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  CREDENTIAL_TRANSFER_PREVIEW_INTENT,
  type CredentialImportChoices,
  type CredentialImportPreview,
  type CredentialTransferEnvelope,
  credentialImportPreviewSchema,
  credentialTransferEnvelopeSchema,
} from "@openmapx/core/api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useActivityClient } from "../activity/activityQueries";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";
import {
  credentialPreviewStorageKey,
  readCredentialPreview,
  retainCredentialPreview,
} from "./credential-preview-storage";
import { downloadMigrationJson } from "./migration-json-download";

type Field = { scope: "integration" | "service"; id: string; key: string };
const identity = (field: Field) => `${field.scope}/${field.id}/${field.key}`;
export function CredentialTransferDialog({
  onClose,
  inventory = [],
}: {
  onClose: () => void;
  inventory?: Field[];
}) {
  const { client, apiUrl } = useActivityClient(),
    { actorId } = useAccountAdmin(),
    [passphrase, setPassphrase] = useState(""),
    [envelope, setEnvelope] = useState<CredentialTransferEnvelope | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<CredentialImportPreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [choicesDirty, setChoicesDirty] = useState(false),
    [ceremony, setCeremony] = useState<"export" | "preview" | "apply" | null>(null),
    [outcome, setOutcome] = useState(""),
    [catalog, setCatalog] = useState<{
      catalogRevisionId: string;
      credentialsRevision: string;
      entries: Array<{ key: string }>;
    } | null>(null),
    [setKeys, setSetKeys] = useState(""),
    [deleteKeys, setDeleteKeys] = useState(""),
    controller = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const storageKey = credentialPreviewStorageKey(apiUrl, actorId);
  const remember = (value: CredentialImportPreview) => {
    retainCredentialPreview(storageKey, value);
    setPreview(value);
  };
  const clear = useCallback(() => {
    epoch.current++;
    controller.current?.abort();
    setPassphrase("");
    setEnvelope(null);
    setPreview(null);
    setSelected([]);
    setCeremony(null);
  }, []);
  useEffect(() => {
    clear();
    if (!apiUrl || !actorId) setError("Administrator session unavailable");
    const restored = readCredentialPreview(storageKey);
    setPreview(restored);
    setSelected(restored?.entries.filter((e) => e.status === "selected").map(identity) ?? []);
    setChoicesDirty(false);
    setSetKeys(
      restored?.feedMap?.changes
        .filter((e) => e.action === "set")
        .map((e) => e.key)
        .join("\n") ?? "",
    );
    setDeleteKeys(
      restored?.feedMap?.changes
        .filter((e) => e.action === "delete")
        .map((e) => e.key)
        .join("\n") ?? "",
    );
    return () => {
      epoch.current++;
      controller.current?.abort();
    };
  }, [apiUrl, actorId, clear, storageKey]);
  const close = () => {
    sessionStorage.removeItem(storageKey);
    clear();
    onClose();
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    controller.current?.abort();
    const next = new AbortController(),
      owner = epoch.current;
    controller.current = next;
    setBusy(true);
    setError("");
    try {
      await action(next.signal);
    } catch {
      if (epoch.current === owner && !next.signal.aborted)
        setError(
          "Credential transfer did not settle. Inspect Activity and use fresh confirmation before another mutation.",
        );
    } finally {
      if (epoch.current === owner) {
        setPassphrase("");
        setBusy(false);
      }
    }
  };
  const options = (signal: AbortSignal) => ({
    client,
    signal,
    maxJsonBytes: 1048576,
    maxErrorBytes: 65536,
  });
  const choices = (): CredentialImportChoices => ({
    entries: (preview?.entries ?? []).map((field) => ({
      scope: field.scope,
      id: field.id,
      key: field.key,
      action: selected.includes(identity(field)) ? "import" : "skip",
    })),
    ...(catalog &&
    preview?.entries.some(
      (e) =>
        e.scope === "service" &&
        e.id === "data-manager" &&
        e.key === "TRANSITOUS_API_KEYS" &&
        selected.includes(identity(e)),
    )
      ? {
          feedMap: {
            catalogRevisionId: catalog.catalogRevisionId,
            expectedCredentialsRevision: catalog.credentialsRevision,
            setKeys: setKeys
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            deleteKeys: deleteKeys
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        }
      : {}),
  });
  const authorize = async (proofs: Array<{ challengeId: string }>) => {
    const action = ceremony;
    setCeremony(null);
    await run(async (signal) => {
      if (action === "export") {
        const value = unwrapAdminResponse(
          await exportAdminCredentialTransfer(
            {
              selection: inventory.filter((f) => selected.includes(identity(f))),
              passphrase,
              confirmed: true,
            },
            { ...options(signal), headers: { "x-admin-reauth-proof": proofs[0]!.challengeId } },
          ),
        );
        if (!signal.aborted)
          downloadMigrationJson(
            credentialTransferEnvelopeSchema.parse(value),
            "openmapx-vault-transfer.json.enc",
          );
      } else if (action === "preview" && envelope) {
        const value = unwrapAdminResponse(
          await previewAdminCredentialTransfer(
            { envelope, passphrase },
            {
              "idempotency-key": crypto.randomUUID(),
              "x-admin-reauth-proof": proofs[0]!.challengeId,
            },
            options(signal),
          ),
        );
        if (!signal.aborted) {
          remember(credentialImportPreviewSchema.parse(value));
          setEnvelope(null);
          setSelected([]);
        }
      } else if (action === "apply" && preview) {
        const value = unwrapAdminResponse(
          await applyAdminCredentialTransfer(
            {
              previewId: preview.previewId,
              intentFingerprint: preview.intentFingerprint,
              expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
              importProofToken: proofs[0]!.challengeId,
              ...(preview.feedMap ? { transitProofToken: proofs[1]!.challengeId } : {}),
            },
            { "idempotency-key": crypto.randomUUID() },
            options(signal),
          ),
        );
        if (!signal.aborted) {
          setOutcome(
            `${value.outcome}: ${value.steps.map((s) => `${s.scope}/${s.id} ${s.status}`).join("; ")}`,
          );
          setPreview(null);
          sessionStorage.removeItem(storageKey);
        }
      }
    });
  };
  const validPass =
    new TextEncoder().encode(passphrase).length >= 12 &&
    new TextEncoder().encode(passphrase).length <= 1024;
  return (
    <>
      <Dialog open onClose={close} fullWidth maxWidth="sm">
        <DialogTitle>Protected credential transfer</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography>
              Only declared effective vault credentials can be transferred. File, environment,
              authentication and bootstrap secrets require manual setup. Passphrases stay in this
              dialog and are cleared after each request.
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
            {outcome && (
              <Alert severity={outcome.startsWith("applied") ? "success" : "warning"}>
                {outcome}
              </Alert>
            )}
            {!preview && (
              <>
                {inventory.map((field) => (
                  <FormControlLabel
                    sx={{ minWidth: 0, overflowWrap: "anywhere" }}
                    key={identity(field)}
                    label={identity(field)}
                    control={
                      <Checkbox
                        checked={selected.includes(identity(field))}
                        onChange={(_, checked) => {
                          setChoicesDirty(true);
                          setCeremony(null);
                          setSelected((v) =>
                            checked
                              ? [...v, identity(field)]
                              : v.filter((k) => k !== identity(field)),
                          );
                        }}
                      />
                    }
                  />
                ))}
                <TextField
                  label="Transfer passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  helperText="12–1024 UTF-8 bytes. Enter again after returning from sign-in."
                />
                <Button
                  disabled={busy || !validPass || !selected.length}
                  onClick={() => setCeremony("export")}
                >
                  Confirm encrypted export
                </Button>
                <Button component="label" disabled={busy}>
                  Choose encrypted credential file
                  <input
                    hidden
                    type="file"
                    accept=".enc,.json,application/json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      setEnvelope(null);
                      if (!file) return;
                      if (file.size > 1048576) {
                        setError("Encrypted file must be at most1MiB.");
                        return;
                      }
                      const owner = epoch.current;
                      void file.text().then((text) => {
                        if (epoch.current !== owner) return;
                        try {
                          if (new TextEncoder().encode(text).length > 1048576) throw Error();
                          setEnvelope(credentialTransferEnvelopeSchema.parse(JSON.parse(text)));
                        } catch {
                          setError("Encrypted file format is invalid.");
                        }
                      });
                    }}
                  />
                </Button>
                <Button
                  disabled={busy || !validPass || !envelope}
                  onClick={() => setCeremony("preview")}
                >
                  Confirm decrypt and review
                </Button>
              </>
            )}
            {preview && (
              <>
                <Typography>
                  Choose each field explicitly. Existing ordinary credentials are overwritten only
                  when selected.
                </Typography>
                {preview.entries.map((field) => (
                  <FormControlLabel
                    sx={{ minWidth: 0, overflowWrap: "anywhere" }}
                    key={identity(field)}
                    label={`${identity(field)}${field.reason ? `: ${field.reason}` : ""}`}
                    control={
                      <Checkbox
                        disabled={
                          field.status === "denied" &&
                          field.reason !== "explicit_feed_map_choices_required"
                        }
                        checked={selected.includes(identity(field))}
                        onChange={(_, checked) => {
                          setChoicesDirty(true);
                          setCeremony(null);
                          setSelected((v) =>
                            checked
                              ? [...v, identity(field)]
                              : v.filter((k) => k !== identity(field)),
                          );
                        }}
                      />
                    }
                  />
                ))}
                {preview.entries.some(
                  (e) =>
                    e.scope === "service" &&
                    e.id === "data-manager" &&
                    e.key === "TRANSITOUS_API_KEYS",
                ) && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async (signal) => {
                          const value = unwrapAdminResponse(
                            await getAdminTransitCredentials(undefined, options(signal)),
                          );
                          if (!signal.aborted) setCatalog(value);
                        })
                      }
                    >
                      Load current feed credential revision
                    </Button>
                    {catalog && (
                      <Typography>
                        {catalog.entries.length} current feed credential IDs; catalog{" "}
                        {catalog.catalogRevisionId}.
                      </Typography>
                    )}
                    <TextField
                      multiline
                      minRows={2}
                      label="Imported feed IDs to set (one per line)"
                      value={setKeys}
                      onChange={(e) => {
                        setChoicesDirty(true);
                        setCeremony(null);
                        setSetKeys(e.target.value);
                      }}
                    />
                    <TextField
                      multiline
                      minRows={2}
                      label="Current feed IDs to delete (one per line)"
                      value={deleteKeys}
                      onChange={(e) => {
                        setChoicesDirty(true);
                        setCeremony(null);
                        setDeleteKeys(e.target.value);
                      }}
                    />
                  </>
                )}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async (signal) => {
                      const value = unwrapAdminResponse(
                        await chooseAdminCredentialTransferFields(
                          preview.previewId,
                          {
                            expectedIntentFingerprint: preview.intentFingerprint,
                            choices: choices(),
                          },
                          { "idempotency-key": crypto.randomUUID() },
                          options(signal),
                        ),
                      );
                      if (!signal.aborted) {
                        remember(credentialImportPreviewSchema.parse(value));
                        setChoicesDirty(false);
                      }
                    })
                  }
                >
                  Review selected fields
                </Button>
                <Typography>
                  {preview.entries.filter((e) => e.status === "selected").length} selected;{" "}
                  {preview.entries.filter((e) => e.status === "skipped").length} skipped;{" "}
                  {preview.entries.filter((e) => e.status === "denied").length} denied.
                </Typography>
                <Button
                  disabled={
                    busy ||
                    choicesDirty ||
                    !preview.applyable ||
                    Date.parse(preview.expiresAt) <= Date.now()
                  }
                  onClick={() => setCeremony("apply")}
                >
                  Confirm selected credential import
                </Button>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={close}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
      {ceremony &&
        (ceremony === "apply" && preview?.feedMap ? (
          <AdminReauthenticationDialog
            purposes={[
              {
                purpose: "credentials.import",
                targetId: preview.previewId,
                intentFingerprint: preview.intentFingerprint,
              },
              {
                purpose: "transit.credentials",
                targetId: preview.feedMap.catalogRevisionId,
                intentFingerprint: preview.intentFingerprint,
              },
            ]}
            onCompleted={(proofs) => void authorize(proofs)}
            onClose={() => setCeremony(null)}
          />
        ) : (
          <AdminReauthenticationDialog
            purpose={ceremony === "export" ? "credentials.export" : "credentials.import"}
            targetId={ceremony === "apply" ? preview!.previewId : "vault-transfer"}
            {...(ceremony === "apply"
              ? { intentFingerprint: preview!.intentFingerprint }
              : ceremony === "preview"
                ? { intentFingerprint: CREDENTIAL_TRANSFER_PREVIEW_INTENT }
                : {})}
            onCompleted={(proofs) => void authorize(proofs)}
            onClose={() => setCeremony(null)}
          />
        ))}
    </>
  );
}
