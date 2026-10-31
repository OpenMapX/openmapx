"use client";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type PrivacyCaseClient, privacyResult } from "@/lib/admin/privacyAdmin";
export function PrivacyCaseDecisionForms({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const w = useTranslations("privacyAdmin.workflows");
  const [extended, setExtended] = useState(""),
    [notified, setNotified] = useState(""),
    [extensionReason, setExtensionReason] = useState(""),
    [reason, setReason] = useState(""),
    [decision, setDecision] = useState<"refused" | "clarification_needed" | "operator_review">(
      "clarification_needed",
    ),
    [confirm, setConfirm] = useState(false);
  const allowed = (value: string) =>
    value === "refused" ||
    value === detail.request.state ||
    (value === "clarification_needed" &&
      [
        "identity_pending",
        "preserving",
        "collecting",
        "pending_processor",
        "operator_review",
      ].includes(detail.request.state)) ||
    (value === "operator_review" &&
      ["collecting", "clarification_needed"].includes(detail.request.state));
  const decide = async () => {
    setConfirm(false);
    await client.execute("case-decision", (c, h) =>
      privacyResult(
        sdk.decidePrivacyAdminCase(
          detail.request.id,
          { version: detail.request.version, decision, reasonCode: reason },
          h,
          { client: c },
        ),
      ),
    );
  };
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{w("caseDecisions")}</Typography>
      <Typography>
        {w("originalDueAt")}: {detail.request.originalDueAt ?? detail.request.dueAt} ·{" "}
        {detail.request.timeZone}
      </Typography>
      <Typography>
        {w("currentDueAt")}: {detail.request.dueAt}
      </Typography>
      <TextField
        label={w("extendedUntil")}
        type="datetime-local"
        slotProps={{ inputLabel: { shrink: true } }}
        value={extended}
        disabled={client.pending || !detail.capabilities.extendDeadline}
        onChange={(e) => setExtended(e.target.value)}
      />
      <TextField
        label={w("extensionNotifiedAt")}
        type="datetime-local"
        slotProps={{ inputLabel: { shrink: true } }}
        value={notified}
        disabled={client.pending || !detail.capabilities.extendDeadline}
        onChange={(e) => setNotified(e.target.value)}
      />
      <TextField
        label={w("extensionReason")}
        value={extensionReason}
        onChange={(e) => setExtensionReason(e.target.value)}
        disabled={client.pending}
      />
      <Button
        disabled={
          client.pending ||
          !detail.capabilities.extendDeadline ||
          !extended ||
          !notified ||
          !extensionReason
        }
        onClick={() =>
          void client.execute("case-extension", (c, h) =>
            privacyResult(
              sdk.extendPrivacyAdminCase(
                detail.request.id,
                {
                  version: detail.request.version,
                  extendedUntil: new Date(extended).toISOString(),
                  extensionNotifiedAt: new Date(notified).toISOString(),
                  reasonCode: extensionReason,
                },
                h,
                { client: c },
              ),
            ),
          )
        }
      >
        {w("recordExtension")}
      </Button>
      <TextField
        select
        label={w("caseDecision")}
        value={decision}
        onChange={(e) => setDecision(e.target.value as typeof decision)}
        disabled={client.pending || !detail.capabilities.caseDecision}
      >
        {(["clarification_needed", "operator_review", "refused"] as const).map((x) => (
          <MenuItem key={x} value={x} disabled={!allowed(x)}>
            {w(`caseStates.${x}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={w("decisionReason")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={client.pending}
      />
      <Button
        color={decision === "refused" ? "error" : "primary"}
        disabled={
          client.pending || !detail.capabilities.caseDecision || !reason || !allowed(decision)
        }
        onClick={() => (decision === "refused" ? setConfirm(true) : void decide())}
      >
        {w("recordCaseDecision")}
      </Button>
      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogTitle>{w("confirmRefusal")}</DialogTitle>
        <DialogContent>{w("refusalHelp")}</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>{w("cancel")}</Button>
          <Button color="error" onClick={() => void decide()}>
            {w("confirmRefusal")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
