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
import { useMemo, useState } from "react";
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
  const showToast = useAdminToast();
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
        if (execution.active) {
          showToast(`Queued notable-places build (${jobId})`);
          setConfirmOpen(false);
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Operation failed", "error");
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
              Notable places
            </Typography>
            {(status?.status || status?.building) && (
              <Chip
                label={status?.building ? "building" : status.status}
                color={status?.status === "failed" ? "error" : "primary"}
                variant="outlined"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Places covered by many Wikipedias, from Wikidata, so search tells the Louvre in Paris
            from a bar of that name nearby. Rebuilt monthly on its own.
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} onClick={() => statusQuery.refetch()}>
          Refresh
        </Button>
        <Button component={Link} href="/admin/activity" variant="text">
          View jobs
        </Button>
      </Stack>

      {statusQuery.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {sdk.adminErrorMessage(
            statusQuery.error,
            statusQuery.error instanceof Error ? statusQuery.error.message : "Status unavailable",
          )}
        </Alert>
      )}
      {status === null && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          No notable-places index is published yet. Search ranks far-away places by the
          geocoder&apos;s order alone until it is.
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
            ["Places", status.placeCount?.toLocaleString() ?? "—"],
            ["Names", status.nameCount?.toLocaleString() ?? "—"],
            ["Min. Wikipedias", status.minSitelinks?.toString() ?? "—"],
            ["Published", status.publishedAt ? new Date(status.publishedAt).toLocaleString() : "—"],
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
        {status?.ok ? "Rebuild now" : "Build now"}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title="Build notable-places index"
        message="Download the notable places from the Wikidata SPARQL endpoint and publish them atomically? This fetches a few hundred megabytes and takes a couple of minutes."
        confirmLabel="Start build"
        loading={operation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => operation.mutate()}
      />
    </Paper>
  );
}
