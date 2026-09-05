"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import NativeSelect from "@mui/material/NativeSelect";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

type ApprovalScope = "legal-content" | "dsar-process" | "security-review";
type ApprovalDecision = "approved" | "rejected";

interface ApprovalPayload {
  scope: ApprovalScope;
  version: string;
  decision: ApprovalDecision;
  findingsDigest: string | null;
  reviewedAt: string;
  expiresAt: string;
}

const ERROR_KEYS: Record<string, string> = {
  IMPLEMENTATION_OWNERS_NOT_CONFIGURED: "implementationOwners",
  EVIDENCE_VERSION_MISMATCH: "evidenceChanged",
  FULL_ADMIN_REQUIRED: "fullAdmin",
  IDEMPOTENCY_KEY_REUSED: "idempotencyConflict",
  INVALID_APPROVAL: "invalid",
};

function toIso(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function hashReviewRecord(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function PrivacyApprovalForm({
  evidenceVersion,
  onRecorded,
}: {
  evidenceVersion: string;
  onRecorded: () => void | Promise<void>;
}) {
  const t = useTranslations("privacySetup");
  const env = useEnv();
  const [scope, setScope] = useState<ApprovalScope | "">("");
  const [decision, setDecision] = useState<ApprovalDecision | "">("");
  const [reviewedAt, setReviewedAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reviewRecord, setReviewRecord] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { severity: "success" | "error"; message: string; code?: string } | undefined
  >();
  const intent = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const previousEvidenceVersion = useRef(evidenceVersion);

  useEffect(() => {
    if (previousEvidenceVersion.current === evidenceVersion) return;
    previousEvidenceVersion.current = evidenceVersion;
    setScope("");
    setDecision("");
    setReviewedAt("");
    setExpiresAt("");
    setReviewRecord("");
    setResult(undefined);
    intent.current = null;
  }, [evidenceVersion]);

  const reviewedIso = toIso(reviewedAt);
  const expiresIso = toIso(expiresAt);
  const record = reviewRecord.trim();
  const valid =
    scope !== "" &&
    decision !== "" &&
    reviewedIso !== null &&
    expiresIso !== null &&
    Date.parse(expiresIso) > Date.parse(reviewedIso) &&
    (decision !== "rejected" || record !== "");

  const submit = async () => {
    if (!valid || !scope || !decision || !reviewedIso || !expiresIso) return;
    setSubmitting(true);
    setResult(undefined);
    try {
      const payload: ApprovalPayload = {
        scope,
        version: evidenceVersion,
        decision,
        findingsDigest: record ? await hashReviewRecord(record) : null,
        reviewedAt: reviewedIso,
        expiresAt: expiresIso,
      };
      const fingerprint = JSON.stringify(payload);
      if (!intent.current || intent.current.fingerprint !== fingerprint) {
        intent.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
      }
      const response = await fetch(`${env.apiUrl}/api/privacy/admin/approvals`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intent.current.idempotencyKey,
        },
        body: fingerprint,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string };
        const errorKey = body.code ? ERROR_KEYS[body.code] : undefined;
        setResult({
          severity: "error",
          message: errorKey ? t(`approval.errors.${errorKey}`) : t("approval.errors.generic"),
          code: body.code,
        });
        return;
      }
      intent.current = null;
      setResult({ severity: "success", message: t("approval.recorded") });
      setScope("");
      setDecision("");
      setReviewedAt("");
      setExpiresAt("");
      setReviewRecord("");
      await onRecorded();
    } catch {
      setResult({ severity: "error", message: t("approval.errors.generic") });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack sx={{ gap: 1.5 }}>
        <Alert severity="warning">{t("approval.independenceNotice")}</Alert>
        <Typography variant="body2">
          {t("approval.evidenceVersion", { version: evidenceVersion })}
        </Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(240px, 1fr))" },
            gap: 1.5,
          }}
        >
          <FormControl size="small" required>
            <InputLabel htmlFor="privacy-approval-scope">{t("approval.scope")}</InputLabel>
            <NativeSelect
              id="privacy-approval-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as ApprovalScope | "")}
              inputProps={{ "aria-label": t("approval.scope") }}
            >
              <option value="" />
              <option value="legal-content">{t("approval.scopes.legal-content")}</option>
              <option value="dsar-process">{t("approval.scopes.dsar-process")}</option>
              <option value="security-review">{t("approval.scopes.security-review")}</option>
            </NativeSelect>
          </FormControl>
          <Stack direction="row" useFlexGap sx={{ gap: 1, alignItems: "center" }}>
            <Typography variant="body2" sx={{ mr: 0.5 }}>
              {t("approval.decision")}
            </Typography>
            <Button
              type="button"
              size="small"
              variant={decision === "approved" ? "contained" : "outlined"}
              aria-pressed={decision === "approved"}
              onClick={() => setDecision("approved")}
            >
              {t("approval.approve")}
            </Button>
            <Button
              type="button"
              size="small"
              color="error"
              variant={decision === "rejected" ? "contained" : "outlined"}
              aria-pressed={decision === "rejected"}
              onClick={() => setDecision("rejected")}
            >
              {t("approval.reject")}
            </Button>
          </Stack>
          <TextField
            size="small"
            type="datetime-local"
            required
            label={t("approval.reviewedAt")}
            value={reviewedAt}
            onChange={(event) => setReviewedAt(event.target.value)}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { "aria-label": t("approval.reviewedAt") },
            }}
          />
          <TextField
            size="small"
            type="datetime-local"
            required
            label={t("approval.expiresAt")}
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            error={Boolean(
              expiresIso && reviewedIso && Date.parse(expiresIso) <= Date.parse(reviewedIso),
            )}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { "aria-label": t("approval.expiresAt") },
            }}
          />
        </Box>
        <TextField
          size="small"
          label={t("approval.reviewRecord")}
          value={reviewRecord}
          onChange={(event) => setReviewRecord(event.target.value)}
          required={decision === "rejected"}
          error={decision === "rejected" && record === ""}
          helperText={t("approval.reviewRecordHelp")}
          slotProps={{
            htmlInput: {
              "aria-label": t("approval.reviewRecord"),
              maxLength: 2000,
              spellCheck: true,
            },
          }}
          sx={{ maxWidth: 680 }}
        />
        {result && (
          <Alert severity={result.severity}>
            {result.message}
            {result.code && (
              <Box component="details" sx={{ mt: 0.5 }}>
                <Typography component="summary" variant="caption" sx={{ cursor: "pointer" }}>
                  {t("readiness.technicalDetails")}
                </Typography>
                <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                  {result.code}
                </Typography>
              </Box>
            )}
          </Alert>
        )}
        <Box>
          <Button
            type="submit"
            variant="contained"
            disabled={!valid || submitting}
            startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {t("approval.record")}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}
