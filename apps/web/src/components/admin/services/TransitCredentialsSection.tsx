"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import {
  type FeedCredentialPreviewInput,
  feedCredentialPreviewSchema,
} from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { AdminTablePagination } from "../shared/AdminTablePagination";

type FeedCredentialChange = FeedCredentialPreviewInput["changes"][number];

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { readStoredAdminReauthentication } from "@/lib/admin/adminReauthentication";
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
/** Only restore the actor/origin-scoped, already reviewed intent; never apply automatically. */
export function readTransitCredentialContinuation(
  apiUrl: string,
  actorId: string,
): { proposalId?: string } | null {
  const stored = readStoredAdminReauthentication(apiUrl);
  const intent =
    stored?.phase === "completed"
      ? stored.requests.find((r) => r.purpose === "transit.credentials")
      : null;
  if (!intent || !actorId) return null;
  try {
    const prefix = "openmapx-transit-credential-preview:";
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const identity = JSON.parse(key.slice(prefix.length));
      if (
        !Array.isArray(identity) ||
        ![2, 3].includes(identity.length) ||
        identity[0] !== apiUrl ||
        identity[1] !== actorId
      )
        continue;
      const value = restored(key);
      if (
        value &&
        value.preview.catalogRevisionId === intent.targetId &&
        value.preview.intentFingerprint === intent.intentFingerprint &&
        (value.preview.proposalId ?? null) === (identity[2] ?? null)
      )
        return value.preview.proposalId ? { proposalId: value.preview.proposalId } : {};
    }
  } catch {
    /* No matching retained review; let the operator start again. */
  }
  return null;
}
export function TransitCredentialsSection({
  proposalId,
  onReviewFinished,
}: {
  proposalId?: string;
  onReviewFinished?: () => void;
} = {}) {
  const { apiUrl, actorId } = useAccountAdmin();
  return (
    <TransitCredentialView
      key={JSON.stringify([apiUrl, actorId, proposalId ?? null])}
      apiUrl={apiUrl}
      actorId={actorId}
      proposalId={proposalId}
      onReviewFinished={onReviewFinished}
    />
  );
}
function TransitCredentialView({
  apiUrl,
  actorId,
  proposalId,
  onReviewFinished,
}: {
  apiUrl: string;
  actorId: string;
  proposalId?: string;
  onReviewFinished?: () => void;
}) {
  const t = useTranslations("adminServices");
  const tCommon = useTranslations("common");
  const client = useMemo(
    () => createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    [apiUrl],
  );
  const queryClient = useQueryClient(),
    query = useQuery({
      queryKey: ["admin", "transit", "credentials", apiUrl, actorId, proposalId ?? "active"],
      queryFn: async ({ signal }) =>
        sdk.unwrapAdminResponse(
          await sdk.getAdminTransitCredentials(proposalId ? { proposalId } : undefined, {
            client,
            signal,
          }),
        ),
      gcTime: 0,
      enabled: Boolean(actorId),
    });
  const storageKey = `openmapx-transit-credential-preview:${JSON.stringify(proposalId ? [apiUrl, actorId, proposalId] : [apiUrl, actorId])}`;
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
      ...(proposalId ? { proposalId } : {}),
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
      if (identity === epoch.current) setError(t("couldNotPrepareCredentialChanges"));
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
      selected.preview.proposalId !== current.proposalId ||
      selected.preview.credentialsRevision !== current.credentialsRevision ||
      selected.preview.expectedCurrentRevisionId !== current.configurationRevisionId ||
      Date.parse(selected.preview.expiresAt) <= Date.now()
    ) {
      invalidateReview();
      setError(t("theCatalogConfigurationOrCredentials"));
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
          ? t("credentialMapAppliedToData")
          : t("credentialApplicationNeedsAttentionInspect"),
      );
      setReviewed(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* No secret is stored; private drafts still clear. */
      }
      onReviewFinished?.();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["admin", "transit", "credentials", apiUrl, actorId],
        }),
        queryClient.invalidateQueries({ queryKey: ["admin", "transit", "pins", apiUrl, actorId] }),
      ]);
    } catch {
      if (identity === epoch.current) {
        setError(t("credentialApplicationDidNotComplete"));
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
        reviewed.preview.proposalId !== data.proposalId ||
        reviewed.preview.credentialsRevision !== data.credentialsRevision ||
        reviewed.preview.expectedCurrentRevisionId !== data.configurationRevisionId ||
        Date.parse(reviewed.preview.expiresAt) <= Date.now());
  const entries = data?.entries ?? [],
    effectivePage = Math.min(page, Math.max(0, Math.ceil(entries.length / 25) - 1));
  return (
    <Paper id="feed-credentials" variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">{t("transitFeedCredentials")}</Typography>
        <Typography variant="body2">{t("valuesStayMaskedBlankInputs")}</Typography>
        {query.isLoading && <CircularProgress size={24} />}
        {query.isError && (
          <Alert severity="error">{t("feedCredentialInspectionIsUnavailable")}</Alert>
        )}
        {data && (
          <>
            <Stack direction="row" spacing={1}>
              <Chip
                label={
                  data.owner === "vault"
                    ? t("vault")
                    : data.owner === "unset"
                      ? t("notConfigured")
                      : data.owner === "file"
                        ? t("hostFile")
                        : t("hostEnvironment")
                }
              />
              <Button size="small" onClick={() => void query.refetch()} disabled={busy}>
                {t("refresh")}
              </Button>
            </Stack>
            {!data.editable && (
              <Alert severity="info">{data.reason ?? t("manageTheseCredentialsOnThe")}</Alert>
            )}
            {data.pendingApplication && (
              <Alert severity="warning">{t("savedCredentialsHaveNotBeen")}</Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">{success}</Alert>}
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 680 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("key")}</TableCell>
                    <TableCell>{t("status")}</TableCell>
                    {data.editable && (
                      <>
                        <TableCell>{t("newValue")}</TableCell>
                        <TableCell>{t("action")}</TableCell>
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
                          <Chip
                            size="small"
                            label={entry.configured ? t("configured") : t("empty")}
                          />
                          {entry.required && <Chip size="small" label={t("required")} />}
                          {entry.orphaned && (
                            <Chip size="small" color="warning" label={t("orphaned")} />
                          )}
                          {deletions.includes(entry.key) && (
                            <Chip size="small" label={t("deleteSelected")} />
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
                                htmlInput: {
                                  "aria-label": t("newValueForKey", { key: entry.key }),
                                },
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
                              aria-label={t("deleteKey", { key: entry.key })}
                              disabled={busy}
                              onClick={() => setDeleting(entry.key)}
                            >
                              {t("delete")}
                            </Button>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <AdminTablePagination
              count={entries.length}
              page={effectivePage}
              rowsPerPage={25}
              rowsPerPageOptions={[25]}
              onPageChange={(_event, next) => setPage(next)}
              onRowsPerPageChange={() => {}}
              hideSinglePage={false}
            />
            {changes.length > 100 && (
              <Alert severity="warning">{t("reviewKeyLimit", { limit: 100 })}</Alert>
            )}
            {data.editable && (
              <Button
                variant="contained"
                disabled={busy || !changes.length || changes.length > 100}
                onClick={() => void preview()}
              >
                {t("reviewCredentialChanges")}
              </Button>
            )}
          </>
        )}
        {reviewed && (
          <Alert severity={stale ? "warning" : "info"}>
            {stale
              ? t("theCatalogConfigurationOrCredentials")
              : t("reviewKeyChanges", { count: reviewed.preview.changes.length })}
            <Stack spacing={1} sx={{ mt: 1 }}>
              {reviewed.preview.changes.map((change) => (
                <Typography variant="body2" key={change.key}>
                  {t("credentialChange", { action: change.action, key: change.key })}
                </Typography>
              ))}
              <Stack direction="row" spacing={1}>
                <Button
                  disabled={busy}
                  onClick={() => {
                    invalidateReview();
                    onReviewFinished?.();
                  }}
                >
                  {t("cancelReview")}
                </Button>
                <Button disabled={busy || Boolean(stale)} onClick={() => setProving(true)}>
                  {t("confirmAdministratorSignInAnd")}
                </Button>
              </Stack>
            </Stack>
          </Alert>
        )}
        {deleting && (
          <Dialog open onClose={() => setDeleting(null)}>
            <DialogTitle>{t("deleteFeedCredential")}</DialogTitle>
            <DialogContent>
              <Typography>{t("deletingWillBeRemovedFrom", { deleting })}</Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleting(null)}>{tCommon("cancel")}</Button>
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
                {t("confirmDeletion")}
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
