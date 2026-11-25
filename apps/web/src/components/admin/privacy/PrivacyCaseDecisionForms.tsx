"use client";
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { zonedWallClockToInstant } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { REQUEST_TRANSITIONS } from "@openmapx/core/privacy";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { type PrivacyCaseClient, privacyResult } from "@/lib/admin/privacyAdmin";

const DECISIONS = ["in_progress", "waiting_on_requester", "completed", "refused"] as const;
type Decision = (typeof DECISIONS)[number];

export function PrivacyCaseDecisionForms({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const w = useTranslations("privacyAdmin.workflows");
  const format = useAdminFormat();
  const [extended, setExtended] = useState(""),
    [notified, setNotified] = useState(""),
    [extensionReason, setExtensionReason] = useState(""),
    [reason, setReason] = useState(""),
    [decision, setDecision] = useState<Decision>("waiting_on_requester"),
    [confirm, setConfirm] = useState(false);
  // The transition table decides what is offered; work only starts once the
  // requester's identity is known, and completion waits for every task.
  const allowed = (value: Decision) =>
    REQUEST_TRANSITIONS[detail.request.status].includes(value) &&
    (value !== "in_progress" || detail.request.identityMethod !== null) &&
    (value !== "completed" || detail.tasks.every((task) => task.status === "resolved"));
  // Statutory deadlines are read and entered in the request's own zone, which
  // the lines and field labels name.
  const { timeZone } = detail.request;
  const deadline = (value: string) => format.dateTime(value, { timeZone });
  const extendedAt = extended ? zonedWallClockToInstant(timeZone, extended) : null;
  const notifiedAt = notified ? zonedWallClockToInstant(timeZone, notified) : null;
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
        {w("originalDueAt", {
          date: deadline(detail.request.originalDueAt ?? detail.request.dueAt),
          timeZone,
        })}
      </Typography>
      <Typography>
        {w("currentDueAt", { date: deadline(detail.request.dueAt), timeZone })}
      </Typography>
      <TextField
        label={w("extendedUntil", { timeZone })}
        type="datetime-local"
        slotProps={{ inputLabel: { shrink: true } }}
        value={extended}
        disabled={client.pending || !detail.capabilities.extendDeadline}
        onChange={(e) => setExtended(e.target.value)}
      />
      <TextField
        label={w("extensionNotifiedAt", { timeZone })}
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
          !extendedAt ||
          !notifiedAt ||
          !extensionReason
        }
        onClick={() => {
          if (!extendedAt || !notifiedAt) return;
          void client.execute("case-extension", (c, h) =>
            privacyResult(
              sdk.extendPrivacyAdminCase(
                detail.request.id,
                {
                  version: detail.request.version,
                  extendedUntil: extendedAt.toISOString(),
                  extensionNotifiedAt: notifiedAt.toISOString(),
                  reasonCode: extensionReason,
                },
                h,
                { client: c },
              ),
            ),
          );
        }}
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
        {DECISIONS.map((x) => (
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
