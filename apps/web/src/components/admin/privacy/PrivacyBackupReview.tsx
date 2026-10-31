"use client";
import { Alert, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type PrivacyCaseClient, privacyResult } from "@/lib/admin/privacyAdmin";
export function PrivacyBackupReview({
  detail,
  client,
}: {
  detail: PrivacyAdminDetail;
  client: PrivacyCaseClient;
}) {
  const t = useTranslations("privacyAdmin"),
    w = useTranslations("privacyAdmin.workflows");
  const inventory = useQuery(client.binding.queries.backups()),
    reviews = useQuery(client.binding.queries.backupReviews(detail.request.id)),
    omissions = useQuery(client.binding.queries.omissions(detail.request.id));
  const [backupId, setBackupId] = useState(""),
    [reason, setReason] = useState("");
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("backups")}</Typography>
      {inventory.isError && <Alert severity="error">{w("backupUnavailable")}</Alert>}
      {!inventory.isError && inventory.data?.backups.length === 0 && (
        <Typography>{t("noBackups")}</Typography>
      )}
      <TextField
        select
        label={w("backupSelection")}
        value={backupId}
        disabled={client.pending || inventory.isError || !detail.capabilities.backupReview}
        onChange={(e) => setBackupId(e.target.value)}
      >
        <MenuItem value="">{w("chooseBackup")}</MenuItem>
        {inventory.data?.backups.map((b) => (
          <MenuItem key={b.backupId} value={b.backupId}>
            {b.backupId} · {b.verified ? t("verified") : t("unverified")} ·{" "}
            {b.unavailableReason ?? ""}
          </MenuItem>
        ))}
      </TextField>
      <Button
        disabled={
          client.pending || !backupId || inventory.isError || !detail.capabilities.backupReview
        }
        onClick={() =>
          void client.execute("trusted-backup-review", (c, h) =>
            privacyResult(
              sdk.createPrivacyAdminBackupReview(detail.request.id, { backupId }, h, { client: c }),
            ),
          )
        }
      >
        {w("recordBackupReview")}
      </Button>
      {reviews.isError && <Alert severity="error">{w("backupUnavailable")}</Alert>}
      {reviews.data?.reviews.map((review) => (
        <Typography key={review.id}>
          {review.backupId} · {review.decision} · {review.reasonCode} · {review.reviewedAt}
        </Typography>
      ))}
      {omissions.isError && <Alert severity="error">{w("omissionsUnavailable")}</Alert>}
      {omissions.data?.reviews.map((review) => (
        <Stack key={review.warningsDigest} spacing={1}>
          <Typography sx={{ overflowWrap: "anywhere" }}>
            {review.backupReviewId} · {review.warningCodes.join(", ")} · {review.warningsDigest}
          </Typography>
          {review.accepted ? (
            <Typography>{w("omissionsAccepted")}</Typography>
          ) : (
            <>
              <TextField
                label={w("omissionReason")}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                disabled={client.pending || !reason || !detail.capabilities.backupReview}
                onClick={() =>
                  void client.execute("backup-omissions", (c, h) =>
                    privacyResult(
                      sdk.acceptPrivacyAdminBackupOmissions(
                        detail.request.id,
                        {
                          requestVersion: detail.request.version,
                          warningsDigest: review.warningsDigest,
                          reasonCode: reason,
                        },
                        h,
                        { client: c },
                      ),
                    ),
                  )
                }
              >
                {w("acceptDisplayedWarnings")}
              </Button>
            </>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
