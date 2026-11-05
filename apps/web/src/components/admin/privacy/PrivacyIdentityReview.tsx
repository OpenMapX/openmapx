"use client";
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { PrivacyCaseClient } from "@/lib/admin/privacyAdmin";
import { privacyResult } from "@/lib/admin/privacyAdmin";
export function PrivacyIdentityReview({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const t = useTranslations("privacyAdmin"),
    w = useTranslations("privacyAdmin.workflows");
  const [party, setParty] = useState<"subject" | "representative">("subject"),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [authority, setAuthority] = useState(""),
    [authorityOutcome, setAuthorityOutcome] = useState<"pending" | "approved" | "rejected">(
      "approved",
    ),
    [authorize, setAuthorize] = useState(false),
    [outcome, setOutcome] = useState<"verified" | "failed" | "clarification">("verified");
  const [challenge, setChallenge] = useState<string | null>(null),
    [code, setCode] = useState("");
  const live = detail.attachments.filter((a) => Date.parse(a.expiresAt) > Date.now());
  const disabled = client.pending || !detail.capabilities.identityReview;
  const clear = () => {
    setReason("");
    setEvidence("");
    setAuthority("");
    setAuthorityOutcome("approved");
    setAuthorize(false);
    setChallenge(null);
    setCode("");
  };
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("identityParties")}</Typography>
      {detail.identities.map((i) => (
        <Typography key={i.party}>
          {t(`parties.${i.party}`)}: {i.state} · {i.method ?? t("unverified")} · {i.authorityState}
        </Typography>
      ))}
      <Alert severity="info">
        {t("identityProofRequired")} {t("accountLoginProofHelp")}
      </Alert>
      <TextField
        select
        label={w("party")}
        value={party}
        disabled={client.pending}
        onChange={(e) => {
          setParty(e.target.value as typeof party);
          clear();
        }}
      >
        {detail.identities.map((i) => (
          <MenuItem key={i.party} value={i.party}>
            {t(`parties.${i.party}`)}
          </MenuItem>
        ))}
      </TextField>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
        <Button
          disabled={disabled}
          onClick={async () => {
            const result = await client.execute("identity-challenge", (c, h) =>
              privacyResult(
                sdk.issuePrivacyAdminEmailChallenge(detail.request.id, { party }, h, { client: c }),
              ),
            );
            if (result) {
              setChallenge(result.challengeId);
              setCode("");
            }
          }}
        >
          {t("sendIdentityChallenge")}
        </Button>
        {challenge && (
          <>
            <TextField
              label={t("identityCode")}
              value={code}
              slotProps={{ htmlInput: { maxLength: 6, inputMode: "numeric" } }}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button
              disabled={disabled || !/^\d{6}$/.test(code)}
              onClick={async () => {
                const result = await client.execute("identity-challenge-complete", (c, h) =>
                  privacyResult(
                    sdk.completePrivacyAdminEmailChallenge(
                      detail.request.id,
                      challenge,
                      { party, code },
                      h,
                      { client: c },
                    ),
                  ),
                );
                if (result) {
                  setCode("");
                  setChallenge(null);
                }
              }}
            >
              {t("verifyIdentityCode")}
            </Button>
          </>
        )}
      </Stack>
      <TextField
        select
        label={w("identityOutcome")}
        value={outcome}
        disabled={disabled}
        onChange={(e) => setOutcome(e.target.value as typeof outcome)}
      >
        {(["verified", "failed", "clarification"] as const).map((x) => (
          <MenuItem key={x} value={x}>
            {w(`outcomes.${x}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={w("reasonableDoubtCode")}
        value={reason}
        disabled={disabled}
        onChange={(e) => setReason(e.target.value)}
      />
      <TextField
        select
        label={w("identityEvidence")}
        value={evidence}
        disabled={disabled}
        onChange={(e) => setEvidence(e.target.value)}
      >
        <MenuItem value="">{w("chooseEvidence")}</MenuItem>
        {live
          .filter((a) => a.purpose === "identity_evidence")
          .map((a) => (
            <MenuItem key={a.id} value={a.id}>
              {a.filename}
            </MenuItem>
          ))}
      </TextField>
      {party === "representative" && (
        <>
          <TextField
            select
            label={w("authorityOutcome")}
            value={authorityOutcome}
            disabled={disabled}
            onChange={(e) => {
              setAuthorityOutcome(e.target.value as typeof authorityOutcome);
              setAuthorize(false);
            }}
          >
            {(["pending", "approved", "rejected"] as const).map((value) => (
              <MenuItem key={value} value={value}>
                {w(`authorityOutcomes.${value}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label={w("authorityEvidence")}
            value={authority}
            disabled={disabled}
            onChange={(e) => setAuthority(e.target.value)}
          >
            <MenuItem value="">{w("chooseEvidence")}</MenuItem>
            {live
              .filter((a) => a.purpose === "representative_authority")
              .map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.filename}
                </MenuItem>
              ))}
          </TextField>
          <FormControlLabel
            control={
              <Checkbox
                checked={authorize}
                disabled={disabled || authorityOutcome !== "approved"}
                onChange={(_, v) => setAuthorize(v)}
              />
            }
            label={w("deliveryAuthorized")}
          />
          <Button
            disabled={
              disabled ||
              (authorityOutcome === "approved" && !authority) ||
              detail.identities.find((i) => i.party === "representative")?.state !== "verified"
            }
            onClick={() =>
              void client.execute("representative-authority", (c, h) =>
                privacyResult(
                  sdk.reviewPrivacyAdminIdentity(
                    detail.request.id,
                    {
                      version: detail.request.version,
                      party: "representative",
                      outcome: "verified",
                      authorityOutcome,
                      ...(authority ? { authorityAttachmentId: authority } : {}),
                      deliveryAuthorized: authorityOutcome === "approved" && authorize,
                    },
                    h,
                    { client: c },
                  ),
                ),
              )
            }
          >
            {w(authorityOutcome === "approved" ? "approveAuthority" : "recordAuthorityReview")}
          </Button>
        </>
      )}
      <Button
        variant="outlined"
        disabled={disabled || (outcome === "verified" && (!reason || !evidence))}
        onClick={() =>
          void client.execute("identity-review", (c, h) =>
            privacyResult(
              sdk.reviewPrivacyAdminIdentity(
                detail.request.id,
                {
                  version: detail.request.version,
                  party,
                  outcome,
                  ...(outcome === "verified"
                    ? {
                        method: "exceptional_evidence",
                        reasonableDoubtCode: reason,
                        evidenceAttachmentId: evidence,
                      }
                    : {}),
                },
                h,
                { client: c },
              ),
            ),
          )
        }
      >
        {w("recordIdentityReview")}
      </Button>
    </Stack>
  );
}
