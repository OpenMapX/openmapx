"use client";

import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import PrivacyTipIcon from "@mui/icons-material/PrivacyTip";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  completePrivacyReauthentication,
  createPrivacyDataRequest,
  getPrivacyDataRequests,
  type PrivacyArtifactView,
  type PrivacyRequestView,
  privacyArtifactDownloadUrl,
  regeneratePrivacyDataRequest,
  revokePrivacyArtifact,
  startPrivacyReauthentication,
  withdrawPrivacyDataRequest,
} from "@openmapx/core";
import { useFormatter, useTranslations } from "next-intl";
import { forwardRef, useCallback, useEffect, useState } from "react";
import { downloadPrivacyDeviceData } from "@/lib/privacyDeviceData";

const PENDING_REAUTH_KEY = "openmapx:privacy:pending-reauth";
const PENDING_ASSISTED_PROOF_KEY = "openmapx:privacy:pending-assisted-proof";
type PendingReauth = { requestId: string; artifactId: string; challengeId: string };
type PendingAssistedProof = { requestId: string; idempotencyKey: string };

function readyArtifact(
  request: PrivacyRequestView & { artifacts?: PrivacyArtifactView[] },
): PrivacyArtifactView | undefined {
  return request.artifacts?.find((artifact) => artifact.state === "ready");
}

export const PrivacyDataSection = forwardRef<HTMLHeadingElement>(
  function PrivacyDataSection(_props, headingRef) {
    const t = useTranslations("account");
    const format = useFormatter();
    const dateLabel = (value: string | null | undefined) => {
      if (!value) return "";
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? ""
        : format.dateTime(parsed, { dateStyle: "medium", timeStyle: "short" });
    };
    const [requests, setRequests] = useState<
      (PrivacyRequestView & { artifacts?: PrivacyArtifactView[] })[]
    >([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [assistedRequestId, setAssistedRequestId] = useState("");
    const [assistedProofComplete, setAssistedProofComplete] = useState(false);

    const load = useCallback(async () => {
      setLoading(true);
      try {
        const result = await getPrivacyDataRequests();
        const detailed = await Promise.all(
          result.requests.slice(0, 20).map(async (request) => {
            try {
              const response = await fetch(
                `/api/privacy/data-requests/${encodeURIComponent(request.id)}`,
                { credentials: "include", cache: "no-store" },
              );
              if (!response.ok) return request;
              return (await response.json()) as PrivacyRequestView & {
                artifacts?: PrivacyArtifactView[];
              };
            } catch {
              return request;
            }
          }),
        );
        setRequests(detailed);
        setError(null);
      } catch {
        setError(t("privacyData.loadFailed"));
      } finally {
        setLoading(false);
      }
    }, [t]);

    useEffect(() => {
      void load();
    }, [load]);

    useEffect(() => {
      let pending: PendingReauth | null = null;
      try {
        const raw = window.sessionStorage.getItem(PENDING_REAUTH_KEY);
        if (raw) pending = JSON.parse(raw) as PendingReauth;
      } catch {
        pending = null;
      }
      if (!pending?.requestId || !pending.artifactId || !pending.challengeId) return;
      const challenge = pending;
      let cancelled = false;
      void completePrivacyReauthentication(
        challenge.requestId,
        challenge.artifactId,
        challenge.challengeId,
      )
        .then(() => {
          if (cancelled) return;
          window.sessionStorage.removeItem(PENDING_REAUTH_KEY);
          window.location.assign(
            privacyArtifactDownloadUrl(challenge.requestId, challenge.artifactId),
          );
        })
        .catch(() => {
          if (!cancelled) setError(t("privacyData.reauthenticationFailed"));
          try {
            window.sessionStorage.removeItem(PENDING_REAUTH_KEY);
          } catch {
            /* ignore */
          }
        });
      return () => {
        cancelled = true;
      };
    }, [t]);

    useEffect(() => {
      let pending: PendingAssistedProof | null = null;
      try {
        const raw = window.sessionStorage.getItem(PENDING_ASSISTED_PROOF_KEY);
        if (raw) pending = JSON.parse(raw) as PendingAssistedProof;
      } catch {
        pending = null;
      }
      if (!pending?.requestId || !pending.idempotencyKey) return;
      const proof = pending;
      let cancelled = false;
      void fetch(
        `/api/privacy/assisted-requests/${encodeURIComponent(proof.requestId)}/identity/account-login`,
        {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Idempotency-Key": proof.idempotencyKey },
        },
      )
        .then((response) => {
          if (!response.ok) throw new Error("account login proof failed");
          if (!cancelled) setAssistedProofComplete(true);
        })
        .catch(() => {
          if (!cancelled) setError(t("privacyData.assistedProofFailed"));
        })
        .finally(() => {
          try {
            window.sessionStorage.removeItem(PENDING_ASSISTED_PROOF_KEY);
          } catch {
            /* ignore */
          }
        });
      return () => {
        cancelled = true;
      };
    }, [t]);

    const create = async () => {
      setBusy("create");
      try {
        await createPrivacyDataRequest("access_and_portability");
        await load();
      } catch {
        setError(t("privacyData.requestFailed"));
      } finally {
        setBusy(null);
      }
    };

    const startAssistedAccountProof = () => {
      const requestId = assistedRequestId.trim();
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
        setError(t("privacyData.assistedProofFailed"));
        return;
      }
      window.sessionStorage.setItem(
        PENDING_ASSISTED_PROOF_KEY,
        JSON.stringify({
          requestId,
          idempotencyKey: `privacy-assisted-${crypto.randomUUID()}`,
        } satisfies PendingAssistedProof),
      );
      window.location.assign("/auth/privacy");
    };

    const startDownload = async (
      request: PrivacyRequestView & { artifacts?: PrivacyArtifactView[] },
      artifact: PrivacyArtifactView,
    ) => {
      setBusy(artifact.id);
      try {
        const challenge = await startPrivacyReauthentication(request.id, artifact.id);
        window.sessionStorage.setItem(
          PENDING_REAUTH_KEY,
          JSON.stringify({
            requestId: request.id,
            artifactId: artifact.id,
            challengeId: challenge.challengeId,
          }),
        );
        window.location.assign(challenge.loginPath);
      } catch {
        setError(t("privacyData.reauthenticationFailed"));
      } finally {
        setBusy(null);
      }
    };

    const revoke = async (
      request: PrivacyRequestView & { artifacts?: PrivacyArtifactView[] },
      artifact: PrivacyArtifactView,
    ) => {
      setBusy(artifact.id);
      try {
        await revokePrivacyArtifact(request.id, artifact.id);
        await load();
      } catch {
        setError(t("privacyData.actionFailed"));
      } finally {
        setBusy(null);
      }
    };

    const regenerate = async (
      request: PrivacyRequestView & { artifacts?: PrivacyArtifactView[] },
    ) => {
      setBusy(request.id);
      try {
        await regeneratePrivacyDataRequest(request.id, request.version);
        await load();
      } catch {
        setError(t("privacyData.actionFailed"));
      } finally {
        setBusy(null);
      }
    };

    const withdraw = async (
      request: PrivacyRequestView & { artifacts?: PrivacyArtifactView[] },
    ) => {
      setBusy(request.id);
      try {
        await withdrawPrivacyDataRequest(request.id, request.version);
        await load();
      } catch {
        setError(t("privacyData.actionFailed"));
      } finally {
        setBusy(null);
      }
    };

    return (
      <Box>
        <Typography
          ref={headingRef}
          tabIndex={-1}
          variant="subtitle2"
          sx={{ fontWeight: 600, mb: 1.5, outline: "none" }}
        >
          {t("privacyData.title")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
          {t("privacyData.description")}
        </Typography>
        {error && (
          <Alert severity="warning" onClose={() => setError(null)} sx={{ mb: 1.5 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
          <Button
            variant="contained"
            size="small"
            startIcon={<PrivacyTipIcon />}
            onClick={() => void create()}
            disabled={busy !== null}
          >
            {busy === "create" ? <CircularProgress size={16} /> : t("privacyData.requestCopy")}
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadIcon />}
            onClick={() => void downloadPrivacyDeviceData()}
          >
            {t("privacyData.downloadDevice")}
          </Button>
        </Box>
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="subtitle2">{t("privacyData.assistedProofTitle")}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
          {t("privacyData.assistedProofDescription")}
        </Typography>
        {assistedProofComplete && (
          <Alert severity="success" sx={{ mb: 1 }}>
            {t("privacyData.assistedProofComplete")}
          </Alert>
        )}
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
          <TextField
            size="small"
            label={t("privacyData.assistedRequestReference")}
            value={assistedRequestId}
            onChange={(event) => setAssistedRequestId(event.target.value)}
          />
          <Button
            variant="outlined"
            size="small"
            disabled={busy !== null || !/^[0-9a-f-]{36}$/i.test(assistedRequestId.trim())}
            onClick={startAssistedAccountProof}
          >
            {t("privacyData.assistedProofAction")}
          </Button>
        </Box>
        <Divider sx={{ my: 1.5 }} />
        {loading ? (
          <CircularProgress size={20} />
        ) : requests.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("privacyData.noRequests")}
          </Typography>
        ) : (
          <List dense disablePadding>
            {requests.map((request) => {
              const artifact = readyArtifact(request);
              const terminal = ["withdrawn", "refused", "closed"].includes(request.state);
              return (
                <ListItem
                  key={request.id}
                  disableGutters
                  alignItems="flex-start"
                  sx={{ display: "block", py: 1 }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      <PrivacyTipIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText
                      primary={t(`privacyData.states.${request.state}`)}
                      secondary={t("privacyData.due", { date: dateLabel(request.dueAt) })}
                    />
                    <Chip
                      size="small"
                      label={
                        request.kind === "access_and_portability"
                          ? t("privacyData.accessAndPortability")
                          : request.kind === "portability"
                            ? t("privacyData.portability")
                            : t("privacyData.access")
                      }
                    />
                  </Box>
                  <Box sx={{ pl: 4, display: "flex", gap: 1, flexWrap: "wrap", mt: 0.75 }}>
                    {artifact && (
                      <Button
                        size="small"
                        startIcon={<DownloadIcon />}
                        disabled={busy !== null}
                        onClick={() => void startDownload(request, artifact)}
                      >
                        {t("privacyData.download")}
                      </Button>
                    )}
                    {artifact && (
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteIcon />}
                        disabled={busy !== null}
                        onClick={() => void revoke(request, artifact)}
                      >
                        {t("privacyData.revoke")}
                      </Button>
                    )}
                    {!terminal && request.state !== "ready" && (
                      <Button
                        size="small"
                        color="warning"
                        onClick={() => void withdraw(request)}
                        disabled={busy !== null}
                      >
                        {t("privacyData.withdraw")}
                      </Button>
                    )}
                    {(request.state === "artifact_expired" || request.state === "delivered") && (
                      <Button
                        size="small"
                        startIcon={<RefreshIcon />}
                        onClick={() => void regenerate(request)}
                        disabled={busy !== null}
                      >
                        {t("privacyData.regenerate")}
                      </Button>
                    )}
                  </Box>
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>
    );
  },
);
