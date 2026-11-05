"use client";
import { Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail, PrivacyOperatorTask } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { PrivacyCaseClient } from "@/lib/admin/privacyAdmin";
import { privacyResult } from "@/lib/admin/privacyAdmin";
export function PrivacyTaskActions({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const t = useTranslations("privacyAdmin");
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("tasks")}</Typography>
      {detail.tasks.map((task) => (
        <Task key={task.id} task={task} detail={detail} client={client} />
      ))}
    </Stack>
  );
}
function Task({
  task,
  detail,
  client,
}: {
  task: PrivacyOperatorTask;
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const w = useTranslations("privacyAdmin.workflows");
  const [assignee, setAssignee] = useState(task.assignedTo ?? ""),
    [status, setStatus] = useState<
      "complete" | "not_applicable" | "operator_review" | "retryable" | "canceled"
    >("operator_review"),
    [reason, setReason] = useState(""),
    [redaction, setRedaction] = useState(""),
    [count, setCount] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const operators = useQuery(client.binding.queries.operators(cursor));
  const actions = task.actions ?? [];
  return (
    <Stack spacing={1} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Typography>
        {task.registrationId} · {task.status} · {task.recordCount ?? "—"}
      </Typography>
      <TextField
        select
        label={w("assignee")}
        value={assignee}
        disabled={client.pending || !detail.capabilities.taskAssignment || operators.isError}
        onChange={(e) => setAssignee(e.target.value)}
      >
        <MenuItem value="">{w("unassigned")}</MenuItem>
        {assignee && !operators.data?.operators.some((o) => o.id === assignee) && (
          <MenuItem value={assignee}>{assignee}</MenuItem>
        )}
        {operators.data?.operators.map((o) => (
          <MenuItem key={o.id} value={o.id}>
            {o.name}
          </MenuItem>
        ))}
      </TextField>
      {operators.data?.nextCursor && (
        <Button onClick={() => setCursor(operators.data!.nextCursor!)}>{w("moreOperators")}</Button>
      )}
      <Button
        disabled={
          client.pending ||
          !detail.capabilities.taskAssignment ||
          assignee === (task.assignedTo ?? "")
        }
        onClick={() =>
          void client.execute("task-assignment", (c, h) =>
            privacyResult(
              sdk.assignPrivacyAdminTask(
                detail.request.id,
                task.id,
                { version: detail.request.version, assignedTo: assignee || null },
                h,
                { client: c },
              ),
            ),
          )
        }
      >
        {w("assignTask")}
      </Button>
      <TextField
        select
        label={w("taskDecision")}
        value={status}
        disabled={client.pending || !actions.length}
        onChange={(e) => setStatus(e.target.value as typeof status)}
      >
        {(["complete", "not_applicable", "operator_review", "retryable", "canceled"] as const).map(
          (x) => (
            <MenuItem key={x} value={x} disabled={!actions.includes(x)}>
              {w(`taskStates.${x}`)}
            </MenuItem>
          ),
        )}
      </TextField>
      <TextField
        label={w("reasonCode")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={client.pending}
      />
      <TextField
        label={w("redactionCode")}
        value={redaction}
        onChange={(e) => setRedaction(e.target.value)}
        disabled={client.pending}
      />
      <TextField
        label={w("recordCount")}
        type="number"
        value={count}
        onChange={(e) => setCount(e.target.value)}
        disabled={client.pending}
        slotProps={{ htmlInput: { min: 0, max: 10000000 } }}
      />
      <Button
        disabled={
          client.pending ||
          !detail.capabilities.taskDecision ||
          !actions.includes(status) ||
          (["not_applicable", "operator_review", "canceled"].includes(status) && !reason) ||
          (status === "complete" &&
            (count === "" ||
              !Number.isSafeInteger(Number(count)) ||
              Number(count) < 0 ||
              Number(count) > 10000000))
        }
        onClick={() =>
          void client.execute("task-decision", (c, h) =>
            privacyResult(
              sdk.decidePrivacyAdminTask(
                detail.request.id,
                task.id,
                {
                  version: detail.request.version,
                  status,
                  ...(reason ? { reasonCode: reason } : {}),
                  ...(redaction ? { redactionCode: redaction } : {}),
                  ...(count !== "" ? { recordCount: Number(count) } : {}),
                },
                h,
                { client: c },
              ),
            ),
          )
        }
      >
        {w("recordTaskDecision")}
      </Button>
    </Stack>
  );
}
