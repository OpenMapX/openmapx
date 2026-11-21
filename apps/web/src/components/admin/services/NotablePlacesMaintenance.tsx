"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { NotablePlacesStatus } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { SERVICE_READ_TIMEOUT_MS } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { runAdminOperation } from "../operations/adminOperationsApi";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

export type { NotablePlacesStatus };

export function notablePlacesStatusQueryKey(apiUrl: string) {
  return ["admin", "notable-places", apiUrl, "status"] as const;
}

/**
 * The Wikidata index that tells search which of several namesakes is famous.
 * The data-manager builds it on its own once and refreshes it monthly; this
 * card shows what is published and lets an operator rebuild it now.
 */
export function NotablePlacesMaintenance({ apiUrl }: { apiUrl: string }) {
  return <NotablePlacesMaintenanceView key={apiUrl} apiUrl={apiUrl} />;
}
function NotablePlacesMaintenanceView({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminServices");
  const format = useAdminFormat();
  const showToast = useAdminToast();
  const [lastAcceptedJobId, setLastAcceptedJobId] = useState<string | null>(null);
  const register = useServiceJobRegistration();
  const client = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
    [apiUrl],
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusQuery = useQuery<NotablePlacesStatus | null>({
    queryKey: notablePlacesStatusQueryKey(apiUrl),
    queryFn: async ({ signal }) => {
      const response = await sdk.getApiDataManagerNotablePlacesStatus({
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
  const owner = useAdminMutationOwner(client, String(confirmOpen));
  const operation = useMutation({
    retry: false,
    mutationFn: async () => {
      const execution = owner;
      const effect = {
        kind: "operations",
        refreshKeys: [notablePlacesStatusQueryKey(apiUrl)],
      } as const;
      try {
        const jobId = await runAdminOperation(client, "notable-places-build", {});
        register({ client, apiUrl, jobId, effect });
        if (execution.active) setLastAcceptedJobId(jobId);
        if (execution.active) {
          showToast(t("notablePlacesBuildQueued", { jobId }));
          setConfirmOpen(false);
        }
      } catch (error) {
        if (execution.active) showToast(adminErrorText(error, t("operationFailed")), "error");
        throw error;
      }
    },
  });

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ gap: 2, alignItems: { md: "center" } }}>
        <Box sx={{ flexGrow: 1 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
            <TravelExploreIcon color="primary" />
            <Typography component="h2" variant="h6">
              {t("notablePlaces")}
            </Typography>
            {(status?.status || status?.building) && (
              <Chip
                label={
                  status?.building || status.status === "building"
                    ? t("building")
                    : status.status === "failed"
                      ? t("failed")
                      : t("ready")
                }
                color={status?.status === "failed" ? "error" : "primary"}
                variant="outlined"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("placesCoveredByManyWikipedias")}
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} onClick={() => statusQuery.refetch()}>
          {t("refresh")}
        </Button>
        <Button
          component={Link}
          href={
            lastAcceptedJobId
              ? adminJobHref({ id: lastAcceptedJobId, source: "application" })
              : "/admin/activity"
          }
          variant="text"
        >
          {t("viewJobsLink")}
        </Button>
      </Stack>

      {statusQuery.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {adminErrorText(statusQuery.error, t("statusUnavailable"))}
        </Alert>
      )}
      {status === null && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          {t("noNotablePlacesIndexIs")}
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
            [t("places"), status.placeCount == null ? "—" : format.number(status.placeCount)],
            [t("names"), status.nameCount == null ? "—" : format.number(status.nameCount)],
            [
              t("minWikipedias"),
              status.minSitelinks == null ? "—" : format.number(status.minSitelinks),
            ],
            [t("published"), format.timestamp(status.publishedAt)],
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

      <Button
        variant="contained"
        sx={{ mt: 2 }}
        disabled={operation.isPending || status?.building === true}
        onClick={() => setConfirmOpen(true)}
      >
        {status?.ok ? t("rebuildNow") : t("buildNow")}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title={t("buildNotablePlacesIndex")}
        message={t("downloadTheNotablePlacesFrom")}
        confirmLabel={t("startBuild")}
        loading={operation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => operation.mutate()}
      />
    </Paper>
  );
}
