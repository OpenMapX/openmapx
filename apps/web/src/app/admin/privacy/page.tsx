"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

type QueueRequest = {
  id: string;
  state: string;
  kind: string;
  dueAt: string;
  version: number;
  identityState?: string;
  userId?: string | null;
  locatorType?: string;
  accountState?: string;
};
type Detail = {
  request: QueueRequest;
  tasks: Array<{
    id: string;
    taskKey: string;
    registrationId: string;
    status: string;
    required: number;
    assignedTo?: string | null;
    recordCount: number | null;
    exceptionCode: string | null;
    redactionCode: string | null;
  }>;
  artifacts: Array<{
    id: string;
    state: string;
    filename: string;
    expiresAt: string | null;
    plaintextBytes: number | null;
  }>;
  identities: Array<{
    party: string;
    state: string;
    method: string | null;
    authorityState: string;
    deliveryAuthorized: number;
    verifiedAt: string | null;
  }>;
};
type Readiness = {
  ready: boolean;
  checkedAt: string;
  evidenceVersion: string;
  checks: Array<{ id: string; status: string; detailCode: string }>;
};
type Backup = {
  backupId: string;
  createdAt: string;
  platformVersion: string | null;
  formatVersion: number | null;
  manifestDigest: string | null;
  verified: boolean;
  expired: boolean;
  unavailableReason?: string;
};
type BackupOmissionReview = {
  backupReviewId: string;
  manifestDigest: string;
  warningCodes: string[];
  warningsDigest: string;
  accepted: boolean;
};

function key(): string {
  return `privacy-admin-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`privacy admin request failed (${response.status})`);
  return (await response.json()) as T;
}

export default function PrivacyAdminPage() {
  const t = useTranslations("privacyAdmin");
  const account = useTranslations("account.privacyData");
  const format = useFormatter();
  const date = (value: string) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? value
      : format.dateTime(parsed, { dateStyle: "medium", timeStyle: "short" });
  };
  const state = (value: string) =>
    account.has(`states.${value}`) ? account(`states.${value}`) : value;

  const [queue, setQueue] = useState<QueueRequest[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupOmissions, setBackupOmissions] = useState<BackupOmissionReview[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [subjectLocator, setSubjectLocator] = useState("");
  const [locatorType, setLocatorType] = useState("email");
  const [accountState, setAccountState] = useState("inaccessible");
  const [channel, setChannel] = useState("email");
  const [representativeContact, setRepresentativeContact] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [identityChallenges, setIdentityChallenges] = useState<
    Partial<Record<"subject" | "representative", string>>
  >({});
  const [identityCodes, setIdentityCodes] = useState<
    Partial<Record<"subject" | "representative", string>>
  >({});
  const selectedRef = useRef<string | null>(null);
  const detailRequestSequence = useRef(0);

  const resetCaseState = useCallback(() => {
    setDetail(null);
    setBackupOmissions([]);
    setIdentityChallenges({});
    setIdentityCodes({});
  }, []);

  const loadDetail = useCallback(async (id: string, errorMessage: string) => {
    const sequence = ++detailRequestSequence.current;
    try {
      const [requestDetail, omissions] = await Promise.all([
        api<Detail>(`/privacy/admin/requests/${encodeURIComponent(id)}`),
        api<{ reviews: BackupOmissionReview[] }>(
          `/privacy/admin/requests/${encodeURIComponent(id)}/backup-omissions`,
        ),
      ]);
      if (sequence !== detailRequestSequence.current || selectedRef.current !== id) return;
      setDetail(requestDetail);
      setBackupOmissions(omissions.reviews);
      setError(null);
    } catch {
      if (sequence === detailRequestSequence.current && selectedRef.current === id)
        setError(errorMessage);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [queueResult, readinessResult, backupsResult] = await Promise.all([
        api<{ requests: QueueRequest[] }>("/privacy/admin/queue"),
        api<Readiness>("/privacy/admin/readiness"),
        api<{ backups: Backup[] }>("/privacy/admin/backups").catch(() => ({ backups: [] })),
      ]);
      setQueue(queueResult.requests);
      setReadiness(readinessResult);
      setBackups(backupsResult.backups);
      setError(null);
      const next =
        selectedRef.current && queueResult.requests.some((item) => item.id === selectedRef.current)
          ? selectedRef.current
          : queueResult.requests[0]?.id;
      const changed = selectedRef.current !== (next ?? null);
      selectedRef.current = next ?? null;
      setSelected(next ?? null);
      if (next) {
        if (changed) resetCaseState();
        await loadDetail(next, t("loadFailed"));
      } else {
        detailRequestSequence.current += 1;
        resetCaseState();
      }
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [loadDetail, resetCaseState, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (id: string) => {
    selectedRef.current = id;
    setSelected(id);
    resetCaseState();
    await loadDetail(id, t("caseFailed"));
  };

  const mutate = async (path: string, body: Record<string, unknown>) => {
    setWorking(true);
    try {
      await api(path, {
        method: "POST",
        headers: { "Idempotency-Key": key() },
        body: JSON.stringify(body),
      });
      await load();
    } catch {
      setError(t("actionFailed"));
    } finally {
      setWorking(false);
    }
  };

  const createAssisted = async () => {
    setWorking(true);
    try {
      await api("/privacy/admin/requests", {
        method: "POST",
        headers: { "Idempotency-Key": key() },
        body: JSON.stringify({
          channel,
          ...(receivedAt ? { receivedAt: new Date(receivedAt).toISOString() } : {}),
          subject: { locatorType, locator: subjectLocator, accountState },
          ...(channel === "representative"
            ? { representative: { contactType: "email", contact: representativeContact } }
            : {}),
        }),
      });
      setSubjectLocator("");
      setIntakeOpen(false);
      await load();
    } catch {
      setError(t("actionFailed"));
    } finally {
      setWorking(false);
    }
  };

  const issueIdentityChallenge = async (party: "subject" | "representative") => {
    if (!detail) return;
    const requestId = detail.request.id;
    setWorking(true);
    try {
      const result = await api<{ challengeId: string }>(
        `/privacy/admin/requests/${requestId}/identity/email-challenges`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key() },
          body: JSON.stringify({ party }),
        },
      );
      if (selectedRef.current !== requestId) return;
      setIdentityChallenges((current) => ({ ...current, [party]: result.challengeId }));
      setIdentityCodes((current) => ({ ...current, [party]: "" }));
      setError(null);
    } catch {
      if (selectedRef.current === requestId) setError(t("challengeIssueFailed"));
    } finally {
      setWorking(false);
    }
  };

  const completeIdentityChallenge = async (party: "subject" | "representative") => {
    const challengeId = identityChallenges[party];
    const code = identityCodes[party] ?? "";
    if (!detail || !challengeId || !/^\d{6}$/.test(code)) return;
    const requestId = detail.request.id;
    setWorking(true);
    try {
      await api(
        `/privacy/admin/requests/${requestId}/identity/email-challenges/${challengeId}/complete`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key() },
          body: JSON.stringify({ party, code }),
        },
      );
      if (selectedRef.current !== requestId) return;
      setIdentityChallenges((current) => ({ ...current, [party]: undefined }));
      setIdentityCodes((current) => ({ ...current, [party]: "" }));
      await load();
    } catch {
      if (selectedRef.current === requestId) setError(t("challengeCompleteFailed"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="h5" sx={{ flex: 1 }}>
          {t("title")}
        </Typography>
        <Button startIcon={<RefreshIcon />} onClick={() => void load()} disabled={loading}>
          {t("refresh")}
        </Button>
        <Button variant="contained" onClick={() => setIntakeOpen((value) => !value)}>
          {t("newAssistedRequest")}
        </Button>
      </Box>
      {intakeOpen && (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Typography variant="h6">{t("assistedIntake")}</Typography>
            <Typography color="text.secondary">{t("assistedIntakeHelp")}</Typography>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField
                type="datetime-local"
                label={t("receivedAt")}
                value={receivedAt}
                onChange={(event) => setReceivedAt(event.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                select
                label={t("channel")}
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <MenuItem value="email">{t("channels.email")}</MenuItem>
                <MenuItem value="post">{t("channels.post")}</MenuItem>
                <MenuItem value="representative">{t("channels.representative")}</MenuItem>
                <MenuItem value="internal">{t("channels.internal")}</MenuItem>
              </TextField>
              <TextField
                select
                label={t("locatorType")}
                value={locatorType}
                onChange={(event) => setLocatorType(event.target.value)}
              >
                <MenuItem value="email">{t("locatorTypes.email")}</MenuItem>
                <MenuItem value="user_id">{t("locatorTypes.userId")}</MenuItem>
                <MenuItem value="username">{t("locatorTypes.username")}</MenuItem>
                <MenuItem value="erasure_reference">{t("locatorTypes.erasureReference")}</MenuItem>
                <MenuItem value="other_reference">{t("locatorTypes.otherReference")}</MenuItem>
              </TextField>
              <TextField
                select
                label={t("accountState")}
                value={accountState}
                onChange={(event) => setAccountState(event.target.value)}
              >
                <MenuItem value="current">{t("accountStates.current")}</MenuItem>
                <MenuItem value="inaccessible">{t("accountStates.inaccessible")}</MenuItem>
                <MenuItem value="deleted">{t("accountStates.deleted")}</MenuItem>
                <MenuItem value="unknown">{t("accountStates.unknown")}</MenuItem>
              </TextField>
            </Stack>
            <TextField
              label={t("subjectLocator")}
              value={subjectLocator}
              onChange={(event) => setSubjectLocator(event.target.value)}
              helperText={t("subjectLocatorHelp")}
            />
            {channel === "representative" && (
              <TextField
                label={t("representativeContact")}
                value={representativeContact}
                onChange={(event) => setRepresentativeContact(event.target.value)}
                helperText={t("representativeContactHelp")}
              />
            )}
            <Button
              variant="contained"
              disabled={working || !subjectLocator.trim()}
              onClick={() => void createAssisted()}
            >
              {t("recordRequest")}
            </Button>
          </Stack>
        </Paper>
      )}
      {error && (
        <Paper sx={{ p: 1.5, bgcolor: "error.50", color: "error.main" }}>
          <Typography>{error}</Typography>
        </Paper>
      )}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper>
            <Typography variant="subtitle1" sx={{ p: 2, fontWeight: 700 }}>
              {t("queue", { count: queue.length })}
            </Typography>
            <Divider />
            {loading ? (
              <Box sx={{ p: 2 }}>
                <CircularProgress size={20} />
              </Box>
            ) : (
              <List dense disablePadding>
                {queue.map((item) => (
                  <ListItem key={item.id} disablePadding>
                    <ListItemButton
                      selected={selected === item.id}
                      onClick={() => void choose(item.id)}
                    >
                      <ListItemText
                        primary={
                          item.kind === "access_and_portability"
                            ? account("accessAndPortability")
                            : item.kind === "portability"
                              ? account("portability")
                              : account("access")
                        }
                        secondary={t("queueItem", {
                          state: state(item.state),
                          date: date(item.dueAt),
                        })}
                      />
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            )}
            {!loading && queue.length === 0 && (
              <Typography sx={{ p: 2 }} color="text.secondary">
                {t("empty")}
              </Typography>
            )}
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 8 }}>
          <Paper sx={{ p: 2 }}>
            {!detail ? (
              <Typography color="text.secondary">{t("selectRequest")}</Typography>
            ) : (
              <Stack spacing={1.5}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Typography variant="h6" sx={{ flex: 1 }}>
                    {t("case", { id: detail.request.id.slice(0, 8) })}
                  </Typography>
                  <Chip
                    label={state(detail.request.state)}
                    color={detail.request.state === "ready" ? "success" : "default"}
                  />
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {t("caseMetadata", {
                    date: date(detail.request.dueAt),
                    identity: detail.request.identityState ?? t("unknown"),
                  })}
                </Typography>
                <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                  {detail.request.state === "identity_pending" && (
                    <Typography variant="body2" color="text.secondary">
                      {t("identityProofRequired")}
                    </Typography>
                  )}
                  {detail.request.state === "collecting" && (
                    <Button
                      size="small"
                      variant="contained"
                      disabled={working}
                      onClick={() =>
                        void mutate(`/privacy/admin/requests/${detail.request.id}/generate`, {})
                      }
                    >
                      {t("generate")}
                    </Button>
                  )}
                  {detail.request.state === "operator_review" && (
                    <Button
                      size="small"
                      variant="contained"
                      disabled={working}
                      onClick={() =>
                        void mutate(`/privacy/admin/requests/${detail.request.id}/generate`, {})
                      }
                    >
                      {t("generateAfterReview")}
                    </Button>
                  )}
                </Box>
                <Typography variant="subtitle2">{t("identityParties")}</Typography>
                {detail.identities.map((identity) => {
                  const party = identity.party as "subject" | "representative";
                  const challengeId = identityChallenges[party];
                  const code = identityCodes[party] ?? "";
                  return (
                    <Stack key={identity.party} spacing={1}>
                      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                        <Typography variant="body2" sx={{ flex: 1 }}>
                          {t(`parties.${identity.party}`)}
                        </Typography>
                        <Chip size="small" label={identity.state} />
                        {identity.party === "representative" && (
                          <Chip size="small" label={identity.authorityState} />
                        )}
                      </Box>
                      {identity.state !== "verified" && !challengeId && (
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={working}
                          onClick={() => void issueIdentityChallenge(party)}
                        >
                          {t("sendIdentityChallenge")}
                        </Button>
                      )}
                      {identity.state !== "verified" && challengeId && (
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                          <TextField
                            size="small"
                            label={t("identityCode")}
                            value={code}
                            onChange={(event) =>
                              setIdentityCodes((current) => ({
                                ...current,
                                [party]: event.target.value.replace(/\D/g, "").slice(0, 6),
                              }))
                            }
                            slotProps={{
                              htmlInput: { inputMode: "numeric", autoComplete: "one-time-code" },
                            }}
                          />
                          <Button
                            size="small"
                            variant="contained"
                            disabled={working || !/^\d{6}$/.test(code)}
                            onClick={() => void completeIdentityChallenge(party)}
                          >
                            {t("verifyIdentityCode")}
                          </Button>
                        </Stack>
                      )}
                      {party === "subject" && identity.state !== "verified" && (
                        <Typography variant="caption" color="text.secondary">
                          {t("accountLoginProofHelp")}
                        </Typography>
                      )}
                    </Stack>
                  );
                })}
                <Divider />
                <Typography variant="subtitle2">{t("tasks")}</Typography>
                {detail.tasks.map((task) => (
                  <Box key={task.id} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Typography variant="body2" sx={{ flex: 1 }}>
                      {task.registrationId}
                      {task.assignedTo ? ` · ${task.assignedTo.slice(0, 8)}` : ""}
                    </Typography>
                    <Chip size="small" label={task.status} />
                    {task.status === "pending" && (
                      <Button
                        size="small"
                        onClick={() =>
                          void mutate(
                            `/privacy/admin/requests/${detail.request.id}/tasks/${task.id}/decision`,
                            {
                              version: detail.request.version,
                              status: "operator_review",
                              reasonCode: "operator-review-required",
                            },
                          )
                        }
                      >
                        {t("review")}
                      </Button>
                    )}
                  </Box>
                ))}
                <Divider />
                <Typography variant="subtitle2">{t("archives")}</Typography>
                {detail.artifacts.map((artifact) => (
                  <Typography key={artifact.id} variant="body2">
                    {artifact.filename} · {artifact.state}
                    {artifact.expiresAt
                      ? ` · ${t("expires", { date: date(artifact.expiresAt) })}`
                      : ""}
                  </Typography>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>
      </Grid>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          {t("readiness")}
        </Typography>
        {readiness && (
          <>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              {readiness.ready ? <CheckCircleIcon color="success" /> : <ErrorIcon color="error" />}
              <Typography>{readiness.ready ? t("ready") : t("notReady")}</Typography>
              <Chip size="small" label={readiness.evidenceVersion} />
            </Box>
            <List dense disablePadding>
              {readiness.checks.map((check) => (
                <ListItem key={check.id} disableGutters>
                  <ListItemText primary={check.id} secondary={check.detailCode} />
                  <Chip
                    size="small"
                    color={check.status === "pass" ? "success" : "error"}
                    label={check.status}
                  />
                </ListItem>
              ))}
            </List>
          </>
        )}
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          {t("backups")}
        </Typography>
        {backups.length === 0 ? (
          <Typography color="text.secondary">{t("noBackups")}</Typography>
        ) : (
          backups.map((backup) => (
            <Box
              key={backup.backupId}
              sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}
            >
              <SearchIcon fontSize="small" />
              <Typography sx={{ flex: 1 }}>
                {backup.backupId} · {date(backup.createdAt)}
              </Typography>
              <Chip
                size="small"
                label={
                  backup.verified ? t("verified") : (backup.unavailableReason ?? t("unverified"))
                }
                color={backup.verified ? "success" : "warning"}
              />
            </Box>
          ))
        )}
        {detail && backupOmissions.length > 0 && (
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            <Divider />
            <Typography variant="subtitle2">Backup extraction omissions</Typography>
            {backupOmissions.map((review) => (
              <Box key={review.warningsDigest} sx={{ p: 1, border: 1, borderColor: "divider" }}>
                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                  {review.manifestDigest}
                </Typography>
                <Stack direction="row" useFlexGap spacing={0.5} sx={{ my: 1, flexWrap: "wrap" }}>
                  {review.warningCodes.map((warning) => (
                    <Chip key={warning} size="small" color="warning" label={warning} />
                  ))}
                </Stack>
                {review.accepted ? (
                  <Chip size="small" color="success" label="Omissions reviewed" />
                ) : (
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={working}
                    onClick={() =>
                      void mutate(
                        `/privacy/admin/requests/${detail.request.id}/backup-omissions/accept`,
                        {
                          warningsDigest: review.warningsDigest,
                          reasonCode: "verified-justified-source-omission",
                          requestVersion: detail.request.version,
                        },
                      )
                    }
                  >
                    Accept justified omissions
                  </Button>
                )}
              </Box>
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}
