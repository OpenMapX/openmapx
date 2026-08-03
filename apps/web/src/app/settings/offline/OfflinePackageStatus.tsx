"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { OfflinePackageDownloadProgress, OfflinePackageRecord } from "@/lib/offlineAreas";
import { formatBytes } from "@/lib/storageFormat";

interface Props {
  record?: OfflinePackageRecord;
  progress?: OfflinePackageDownloadProgress;
  onResume?: () => void;
  disabled?: boolean;
}

type Status = OfflinePackageRecord["status"] | OfflinePackageDownloadProgress["status"];

function statusText(status: Status, t: (key: string) => string): string {
  switch (status) {
    case "ready":
      return t("ready");
    case "downloading":
      return t("downloading");
    case "paused":
      return t("paused");
    case "error":
      return t("errorStatus");
    case "preparing":
      return t("offlinePreparing");
    case "verifying":
      return t("offlineVerifying");
    case "queued":
      return t("offlinePreparing");
    case "deleting":
      return t("removing");
  }
}

export function OfflinePackageStatus({ record, progress, onResume, disabled = false }: Props) {
  const t = useTranslations("settings");
  const status = progress?.status ?? record?.status ?? "queued";
  const received = progress?.bytesReceived ?? record?.bytesReceived ?? 0;
  const total =
    progress?.bytesTotal ?? record?.bytesTotal ?? record?.manifest.archive.byteLength ?? 0;
  const determinate =
    total > 0 && status !== "preparing" && status !== "queued" && status !== "verifying";
  const percentage = determinate ? Math.min(100, (received / total) * 100) : undefined;
  const resumable = record && (record.status === "paused" || record.status === "error") && onResume;

  return (
    <Stack spacing={0.5} sx={{ width: "100%" }}>
      <Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: "center" }}>
        <Typography variant="body2" component="span" sx={{ color: "text.secondary" }}>
          {statusText(status, t)}
        </Typography>
        {total > 0 && status !== "ready" ? (
          <Typography variant="caption" component="span" sx={{ color: "text.secondary" }}>
            {formatBytes(received)} / {formatBytes(total)}
          </Typography>
        ) : null}
        {resumable ? (
          <Button
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              onResume();
            }}
            disabled={disabled}
            sx={{ ml: "auto" }}
          >
            {t("resume")}
          </Button>
        ) : null}
      </Stack>
      {status === "ready" ? null : (
        <Box sx={{ width: "100%" }}>
          <LinearProgress
            variant={percentage === undefined ? "indeterminate" : "determinate"}
            value={percentage}
          />
        </Box>
      )}
      {record?.lastError ? (
        <Typography variant="caption" component="span" sx={{ color: "error.main" }}>
          {record.lastError.message}
        </Typography>
      ) : null}
    </Stack>
  );
}
