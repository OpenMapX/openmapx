"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { runAdminOperation } from "../operations/adminOperationsApi";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

export interface SearchIndexStatus {
  ok?: boolean;
  error?: string;
  region?: string;
  status?: "building" | "ready" | "failed";
  stale?: boolean;
  building?: boolean;
  epoch?: string | null;
  placeCount?: number;
  termCount?: number;
  sourceFingerprint?: string | null;
  publishedAt?: string | null;
  lastError?: string | null;
}

export function canBuildSearchIndex(
  status: SearchIndexStatus | undefined,
  region: string,
  pending: boolean,
): boolean {
  return region.trim().length > 0 && !pending && status?.building !== true;
}

export function resolveSearchIndexRegion(
  input: string,
  status: SearchIndexStatus | undefined,
): string {
  return input.trim() || status?.region || "";
}

export function SearchIndexMaintenance({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminSearchIndex");
  const locale = useLocale();
  const showToast = useAdminToast();
  const queryClient = useQueryClient();
  const [region, setRegion] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusQuery = useQuery<SearchIndexStatus>({
    queryKey: ["admin", "search-index", "status"],
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/data-manager/search-index/status`, {
        credentials: "include",
      });
      const body = (await response.json().catch(() => ({}))) as SearchIndexStatus;
      if (response.status === 404) return body;
      if (!response.ok) throw new Error(body.error ?? t("loadFailed"));
      return body;
    },
    refetchInterval: (query) => (query.state.data?.building ? 10_000 : 60_000),
  });
  const status = statusQuery.data;
  const effectiveRegion = resolveSearchIndexRegion(region, status);
  const operation = useMutation({
    mutationFn: () => runAdminOperation(apiUrl, "search-index-build", { region: effectiveRegion }),
    onSuccess: (jobId) => {
      showToast(t("queued", { jobId }));
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "search-index", "status"] });
    },
    onError: (error) =>
      showToast(error instanceof Error ? error.message : t("operationFailed"), "error"),
  });

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ gap: 2, alignItems: { md: "center" } }}>
        <Box sx={{ flexGrow: 1 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
            <SearchIcon color="primary" />
            <Typography component="h2" variant="h6">
              {t("title")}
            </Typography>
            {(status?.status || status?.building) && (
              <Chip
                label={
                  status?.building
                    ? t("building")
                    : status.status === "failed"
                      ? t("failed")
                      : status.status === "ready"
                        ? t("ready")
                        : t("building")
                }
                color={
                  status?.status === "failed" ? "error" : status?.stale ? "warning" : "primary"
                }
                variant="outlined"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("description")}
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} onClick={() => statusQuery.refetch()}>
          {t("refresh")}
        </Button>
        <Button component={Link} href="/admin/activity" variant="text">
          {t("viewJobs")}
        </Button>
      </Stack>

      {statusQuery.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {statusQuery.error instanceof Error ? statusQuery.error.message : t("statusUnavailable")}
        </Alert>
      )}
      {status?.ok === false && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          {t("notPublished")}
        </Alert>
      )}
      {status?.stale && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          {t("stale")}
        </Alert>
      )}
      {status?.lastError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {status.lastError}
        </Alert>
      )}
      {status?.building && <LinearProgress sx={{ mt: 1.5 }} />}

      {status?.ok && (
        <Stack direction="row" sx={{ gap: 3, flexWrap: "wrap", mt: 1.5 }}>
          {[
            [t("region"), status.region ?? "—"],
            [t("places"), status.placeCount?.toLocaleString(locale) ?? "—"],
            [t("terms"), status.termCount?.toLocaleString(locale) ?? "—"],
            [t("epoch"), status.epoch ?? "—"],
            [
              t("published"),
              status.publishedAt ? new Date(status.publishedAt).toLocaleString(locale) : "—",
            ],
          ].map(([label, value]) => (
            <Box key={label}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {label}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        sx={{ gap: 1, mt: 2, alignItems: { sm: "center" } }}
      >
        <TextField
          label={t("region")}
          placeholder={status?.region ?? "europe/germany"}
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          sx={{ minWidth: 240 }}
        />
        <Button
          variant="contained"
          disabled={!canBuildSearchIndex(status, effectiveRegion, operation.isPending)}
          onClick={() => setConfirmOpen(true)}
        >
          {status?.stale ? t("rebuild") : t("build")}
        </Button>
      </Stack>

      <ConfirmDialog
        open={confirmOpen}
        title={t("confirmTitle")}
        message={t("confirmMessage", { region: effectiveRegion })}
        confirmLabel={t("startBuild")}
        loading={operation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => operation.mutate()}
      />
    </Paper>
  );
}
