"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { OfflinePackageDownloadProgress, OfflinePackageRecord } from "@/lib/offlineAreas";
import { formatBytes } from "@/lib/storageFormat";

interface Props {
  record?: OfflinePackageRecord;
  progress?: OfflinePackageDownloadProgress;
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

export function OfflinePackageStatus({ record, progress }: Props) {
  const t = useTranslations("settings");
  const status = progress?.status ?? record?.status ?? "queued";
  const received = progress?.bytesReceived ?? record?.bytesReceived ?? 0;
  const total =
    progress?.bytesTotal ?? record?.bytesTotal ?? record?.manifest.archive.byteLength ?? 0;
  const determinate =
    total > 0 && status !== "preparing" && status !== "queued" && status !== "verifying";
  const percentage = determinate
    ? Math.round(Math.min(100, Math.max(0, (received / total) * 100)))
    : undefined;
  const speed = progress?.speedBytesPerSecond ?? 0;

  return (
    <Stack spacing={0.5} sx={{ width: "100%" }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ minWidth: 0, alignItems: "center", flexWrap: "wrap", rowGap: 0.25 }}
      >
        <Typography variant="body2" component="span" sx={{ color: "text.secondary" }}>
          {statusText(status, t)}
        </Typography>
        {percentage !== undefined && status !== "ready" ? (
          <Typography variant="caption" component="span" sx={{ fontWeight: 600 }}>
            {percentage}%
          </Typography>
        ) : null}
        {total > 0 && status !== "ready" ? (
          <Typography variant="caption" component="span" sx={{ color: "text.secondary" }}>
            {formatBytes(received)} / {formatBytes(total)}
          </Typography>
        ) : null}
        {status === "downloading" && speed > 0 ? (
          <Typography variant="caption" component="span" sx={{ color: "text.secondary" }}>
            {t("downloadSpeed", { speed: formatBytes(speed) })}
          </Typography>
        ) : null}
      </Stack>
      {status === "ready" ? null : (
        <Box sx={{ width: "100%" }}>
          <LinearProgress
            variant={percentage === undefined ? "indeterminate" : "determinate"}
            value={percentage}
            aria-label={statusText(status, t)}
            sx={{ height: 8, borderRadius: 1 }}
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
