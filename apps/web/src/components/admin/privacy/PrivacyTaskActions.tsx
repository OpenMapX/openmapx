"use client";
import { Button, Stack, TextField, Typography } from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail, PrivacyOperatorTask } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type PrivacyCaseClient, privacyResult } from "@/lib/admin/privacyAdmin";

/** Operator-held sources: each is checked outside OpenMapX and resolved here
 * with one action and a reason code. */
export function PrivacyTaskActions({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const t = useTranslations("privacyAdmin"),
    w = useTranslations("privacyAdmin.workflows");
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("tasks")}</Typography>
      <Typography variant="body2">{w("tasksHelp")}</Typography>
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
  const [reason, setReason] = useState("");
  const open = task.status === "open";
  return (
    <Stack spacing={1} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Typography>
        {task.registrationId} · {w(`taskStates.${task.status}`)}
        {task.resolutionCode ? ` · ${task.resolutionCode}` : ""}
      </Typography>
      {open && (
        <>
          <TextField
            label={w("reasonCode")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={client.pending || !detail.capabilities.resolveTasks}
          />
          <Button
            disabled={client.pending || !detail.capabilities.resolveTasks || !reason}
            onClick={() =>
              void client.execute("task-resolution", (c, h) =>
                privacyResult(
                  sdk.resolvePrivacyAdminTask(
                    detail.request.id,
                    task.id,
                    { version: detail.request.version, reasonCode: reason },
                    h,
                    { client: c },
                  ),
                ),
              )
            }
          >
            {w("resolveTask")}
          </Button>
        </>
      )}
    </Stack>
  );
}
