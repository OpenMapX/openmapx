"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import {
  type FeedCredentialPreviewInput,
  feedCredentialPreviewSchema,
} from "@openmapx/core/api-contracts";

type FeedCredentialChange = FeedCredentialPreviewInput["changes"][number];

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { browserAdminApiBase } from "@/lib/admin/browserAdminApiBase";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";

type Preview = ReturnType<typeof feedCredentialPreviewSchema.parse>;
type Reviewed = { preview: Preview; operationKey: string };
function restored(key: string): Reviewed | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      Object.keys(value).sort().join(",") !== "operationKey,preview" ||
      !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(value.operationKey)
    )
      return null;
    const preview = feedCredentialPreviewSchema.parse(value.preview);
    return Date.parse(preview.expiresAt) > Date.now()
      ? { preview, operationKey: value.operationKey }
      : null;
  } catch {
    return null;
  }
}
export function TransitCredentialsSection() {
  const { apiUrl, actorId } = useAccountAdmin();
  return (
    <TransitCredentialView
      key={JSON.stringify([apiUrl, actorId])}
      apiUrl={apiUrl}
      actorId={actorId}
    />
  );
}
function TransitCredentialView({ apiUrl, actorId }: { apiUrl: string; actorId: string }) {
  const client = useMemo(
    () => createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    [apiUrl],
  );
  const queryClient = useQueryClient(),
    query = useQuery({
      queryKey: ["admin", "transit", "credentials", apiUrl, actorId],
      queryFn: async ({ signal }) =>
        sdk.unwrapAdminResponse(await sdk.getAdminTransitCredentials({ client, signal })),
      gcTime: 0,
      enabled: Boolean(actorId),
    });
  const storageKey = `openmapx-transit-credential-preview:${JSON.stringify([apiUrl, actorId])}`;
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [deletions, setDeletions] = useState<string[]>([]),
    [deleting, setDeleting] = useState<string | null>(null),
    [reviewed, setReviewed] = useState<Reviewed | null>(null),
    [proving, setProving] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null),
    [page, setPage] = useState(0);
  const epoch = useRef(0),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    setReviewed(restored(storageKey));
    return () => {
      epoch.current++;
      request.current?.abort();
    };
  }, [storageKey]);
  const invalidateReview = () => {
    epoch.current++;
    request.current?.abort();
    setReviewed(null);
    setProving(false);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* No secret is stored; private drafts still clear. */
    }
    setError(null);
    setSuccess(null);
  };
  const changes: FeedCredentialChange[] = [
    ...Object.entries(drafts)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => ({ key, action: "set" as const, value })),
    ...deletions.map((key) => ({ key, action: "delete" as const })),
  ];
  const preview = async () => {
    const data = query.data;
    if (!data || !data.editable || !changes.length || changes.length > 100) return;
    invalidateReview();
    const identity = epoch.current,
      controller = new AbortController();
    request.current = controller;
    setBusy(true);
    const operationKey = `opk1_${crypto.randomUUID().replaceAll("-", "")}`;
    const body = {
      catalogRevisionId: data.catalogRevisionId,
      expectedCredentialsRevision: data.credentialsRevision,
      expectedCurrentRevisionId: data.configurationRevisionId,
      changes,
      operationKey,
    };
    // No secret-bearing mutation variables enter React Query, storage or review state.
    setDrafts({});
    setDeletions([]);
    try {
      const value = sdk.unwrapAdminResponse(
        await sdk.previewAdminTransitCredentials(body, { client, signal: controller.signal }),
      );
      if (identity !== epoch.current) return;
      const next = { preview: feedCredentialPreviewSchema.parse(value), operationKey };
      setReviewed(next);
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      if (identity === epoch.current)
        setError(
          "Could not prepare credential changes. Refresh and enter the intended changes again.",
        );
    } finally {
      if (identity === epoch.current) setBusy(false);
    }
  };
  const apply = async (challengeId: string) => {
    const selected = reviewed,
      current = query.data;
    if (!selected || !current) return;
    if (
      !current.editable ||
      selected.preview.catalogRevisionId !== current.catalogRevisionId ||
      selected.preview.credentialsRevision !== current.credentialsRevision ||
      selected.preview.expectedCurrentRevisionId !== current.configurationRevisionId ||
      Date.parse(selected.preview.expiresAt) <= Date.now()
    ) {
      invalidateReview();
      setError("The catalog, configuration or credentials changed. Prepare a new review.");
      return;
    }
    setProving(false);
    const identity = epoch.current,
      controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = sdk.unwrapAdminResponse(
        await sdk.applyAdminTransitCredentials(
          {
            previewId: selected.preview.previewId,
            intentFingerprint: selected.preview.intentFingerprint,
            operationKey: selected.operationKey,
            transitProofToken: challengeId,
          },
          { client, signal: controller.signal },
        ),
      );
      if (identity !== epoch.current) return;
      setSuccess(
        result.configuration.outcome === "committed" && result.configuration.followUp === "complete"
          ? "Feed credentials applied."
          : "Credential application needs attention. Inspect the original operation in Activity.",
      );
      setReviewed(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* No secret is stored; private drafts still clear. */
      }
      await queryClient.invalidateQueries({ queryKey: ["admin", "transit"] });
    } catch {
      if (identity === epoch.current) {
        setError(
          "Credential application did not complete. Inspect Activity before preparing another change.",
        );
        setReviewed(null);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* No secret is stored; private drafts still clear. */
        }
      }
    } finally {
      if (identity === epoch.current) {
        setDrafts({});
        setDeletions([]);
        setBusy(false);
      }
    }
  };
  const data = query.data,
    stale =
      reviewed &&
      data &&
      (reviewed.preview.catalogRevisionId !== data.catalogRevisionId ||
        reviewed.preview.credentialsRevision !== data.credentialsRevision ||
        reviewed.preview.expectedCurrentRevisionId !== data.configurationRevisionId ||
        Date.parse(reviewed.preview.expiresAt) <= Date.now());
  const entries = data?.entries ?? [],
    effectivePage = Math.min(page, Math.max(0, Math.ceil(entries.length / 25) - 1));
  return (
    <Paper id="feed-credentials" variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Transit feed credentials</Typography>
        <Typography variant="body2">
          Values stay masked. Blank inputs keep the existing value; deletion is a separate,
          confirmed action. Changes use the selected catalog pins.
        </Typography>
        {query.isLoading && <CircularProgress size={24} />}
        {query.isError && (
          <Alert severity="error">
            Feed credential inspection is unavailable. Refresh after restoring instance
            connectivity.
          </Alert>
        )}
        {data && (
          <>
            <Stack direction="row" spacing={1}>
              <Chip
                label={
                  data.owner === "vault"
                    ? "Vault"
                    : data.owner === "unset"
                      ? "Not configured"
                      : data.owner === "file"
                        ? "Host file"
                        : "Host environment"
                }
              />
              <Button size="small" onClick={() => void query.refetch()} disabled={busy}>
                Refresh
              </Button>
            </Stack>
            {!data.editable && (
              <Alert severity="info">
                {data.reason ?? "Manage these credentials on the host."}
              </Alert>
            )}
            {data.pendingApplication && (
              <Alert severity="warning">
                Saved credentials have not been verified in the running Data Manager mount. Inspect
                Activity for the original application.
              </Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">{success}</Alert>}
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 680 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Key</TableCell>
                    <TableCell>Status</TableCell>
                    {data.editable && (
                      <>
                        <TableCell>New value</TableCell>
                        <TableCell>Action</TableCell>
                      </>
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {entries.slice(effectivePage * 25, effectivePage * 25 + 25).map((entry) => (
                    <TableRow key={entry.key}>
                      <TableCell sx={{ overflowWrap: "anywhere" }}>{entry.key}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          <Chip size="small" label={entry.configured ? "Configured" : "Empty"} />
                          {entry.required && <Chip size="small" label="Required" />}
                          {entry.orphaned && <Chip size="small" color="warning" label="Orphaned" />}
                          {deletions.includes(entry.key) && (
                            <Chip size="small" label="Delete selected" />
                          )}
                        </Stack>
                      </TableCell>
                      {data.editable && (
                        <>
                          <TableCell>
                            <TextField
                              size="small"
                              type="password"
                              autoComplete="off"
                              slotProps={{
                                htmlInput: { "aria-label": `New value for ${entry.key}` },
                              }}
                              value={Object.hasOwn(drafts, entry.key) ? drafts[entry.key] : ""}
                              disabled={busy}
                              onChange={(event) => {
                                invalidateReview();
                                setDrafts((current) => ({
                                  ...current,
                                  [entry.key]: event.target.value,
                                }));
                                setDeletions((current) =>
                                  current.filter((key) => key !== entry.key),
                                );
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Button
                              size="small"
                              aria-label={`Delete ${entry.key}`}
                              disabled={busy}
                              onClick={() => setDeleting(entry.key)}
                            >
                              Delete
                            </Button>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <TablePagination
              component="div"
              count={entries.length}
              page={effectivePage}
              rowsPerPage={25}
              rowsPerPageOptions={[25]}
              onPageChange={(_event, next) => setPage(next)}
            />
            {changes.length > 100 && (
              <Alert severity="warning">Review at most 100 key changes at a time.</Alert>
            )}
            {data.editable && (
              <Button
                variant="contained"
                disabled={busy || !changes.length || changes.length > 100}
                onClick={() => void preview()}
              >
                Review credential changes
              </Button>
            )}
          </>
        )}
        {reviewed && (
          <Alert severity={stale ? "warning" : "info"}>
            {stale
              ? "The catalog, configuration or credentials changed. Prepare a new review."
              : `Review ${reviewed.preview.changes.length} key changes. Existing unselected values are preserved.`}
            <Stack spacing={1} sx={{ mt: 1 }}>
              {reviewed.preview.changes.map((change) => (
                <Typography variant="body2" key={change.key}>
                  {change.action === "delete" ? "Delete" : "Set"}: {change.key}
                </Typography>
              ))}
              <Stack direction="row" spacing={1}>
                <Button disabled={busy} onClick={invalidateReview}>
                  Cancel review
                </Button>
                <Button disabled={busy || Boolean(stale)} onClick={() => setProving(true)}>
                  Confirm administrator sign-in and apply
                </Button>
              </Stack>
            </Stack>
          </Alert>
        )}
        {deleting && (
          <Dialog open onClose={() => setDeleting(null)}>
            <DialogTitle>Delete feed credential?</DialogTitle>
            <DialogContent>
              <Typography>
                {deleting} will be removed from the managed map. Other keys will be preserved.
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                onClick={() => {
                  invalidateReview();
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[deleting];
                    return next;
                  });
                  setDeletions((current) => [...new Set([...current, deleting])]);
                  setDeleting(null);
                }}
              >
                Confirm deletion
              </Button>
            </DialogActions>
          </Dialog>
        )}
        {proving && reviewed && (
          <AdminReauthenticationDialog
            purpose="transit.credentials"
            targetId={reviewed.preview.catalogRevisionId}
            intentFingerprint={reviewed.preview.intentFingerprint}
            onClose={() => setProving(false)}
            onCompleted={(proofs) => {
              const proof = proofs[0];
              if (proof) void apply(proof.challengeId);
            }}
          />
        )}
      </Stack>
    </Paper>
  );
}
