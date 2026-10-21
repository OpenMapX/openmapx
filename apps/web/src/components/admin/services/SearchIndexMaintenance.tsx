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
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { SearchIndexStatus } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { SERVICE_READ_TIMEOUT_MS } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { runAdminOperation } from "../operations/adminOperationsApi";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

export type { SearchIndexStatus };

export function canBuildSearchIndex(
  status: Pick<SearchIndexStatus, "building"> | null | undefined,
  region: string,
  pending: boolean,
): boolean {
  return region.trim().length > 0 && !pending && status?.building !== true;
}

export function resolveSearchIndexRegion(
  input: string,
  status: Pick<SearchIndexStatus, "region"> | null | undefined,
): string {
  return input.trim() || status?.region || "";
}

export function searchIndexStatusQueryKey(apiUrl: string) {
  return ["admin", "search-index", apiUrl, "status"] as const;
}

export function SearchIndexMaintenance({ apiUrl }: { apiUrl: string }) {
  return <SearchIndexMaintenanceView key={apiUrl} apiUrl={apiUrl} />;
}
function SearchIndexMaintenanceView({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminSearchIndex");
  const locale = useLocale();
  const showToast = useAdminToast();
  const register = useServiceJobRegistration();
  const client = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
    [apiUrl],
  );
  const [region, setRegion] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusQuery = useQuery<SearchIndexStatus | null>({
    queryKey: searchIndexStatusQueryKey(apiUrl),
    queryFn: async ({ signal }) => {
      const response = await sdk.getApiDataManagerSearchIndexStatus({
        client,
        signal,
        timeoutMs: SERVICE_READ_TIMEOUT_MS,
      });
      if (response.status === 404) return null;
      return sdk.unwrapAdminResponse(response);
    },
    refetchInterval: (query) => (query.state.data?.building ? 10_000 : 60_000),
  });
  const status = statusQuery.data;
  const effectiveRegion = resolveSearchIndexRegion(region, status);
  const owner = useAdminMutationOwner(
    client,
    JSON.stringify([region, effectiveRegion, confirmOpen]),
  );
  const operation = useMutation({
    retry: false,
    mutationFn: async () => {
      const execution = owner;
      const effect = {
        kind: "operations",
        refreshKeys: [searchIndexStatusQueryKey(apiUrl)],
      } as const;
      try {
        const jobId = await runAdminOperation(client, "search-index-build", {
          region: effectiveRegion,
        });
        register({ client, apiUrl, jobId, effect });
        if (execution.active) {
          showToast(t("queued", { jobId }));
          setConfirmOpen(false);
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : t("operationFailed"), "error");
        throw error;
      }
    },
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
          {sdk.adminErrorMessage(
            statusQuery.error,
            statusQuery.error instanceof Error ? statusQuery.error.message : t("statusUnavailable"),
          )}
        </Alert>
      )}
      {status === null && (
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
