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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { runAdminOperation } from "../operations/adminOperationsApi";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

export interface NotablePlacesStatus {
  ok?: boolean;
  error?: string;
  status?: "building" | "ready" | "failed";
  building?: boolean;
  placeCount?: number;
  nameCount?: number;
  minSitelinks?: number | null;
  source?: string | null;
  epoch?: string | null;
  publishedAt?: string | null;
  lastError?: string | null;
}

/**
 * The Wikidata index that tells search which of several namesakes is famous.
 * The data-manager builds it on its own once and refreshes it monthly; this
 * card shows what is published and lets an operator rebuild it now.
 */
export function NotablePlacesMaintenance({ apiUrl }: { apiUrl: string }) {
  const showToast = useAdminToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusQuery = useQuery<NotablePlacesStatus>({
    queryKey: ["admin", "notable-places", "status"],
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/data-manager/notable-places/status`, {
        credentials: "include",
      });
      const body = (await response.json().catch(() => ({}))) as NotablePlacesStatus;
      if (response.status === 404) return body;
      if (!response.ok) throw new Error(body.error ?? "Failed to load notable-places status");
      return body;
    },
    refetchInterval: (query) => (query.state.data?.building ? 10_000 : 60_000),
  });
  const status = statusQuery.data;
  const operation = useMutation({
    mutationFn: () => runAdminOperation(apiUrl, "notable-places-build", {}),
    onSuccess: (jobId) => {
      showToast(`Queued notable-places build (${jobId})`);
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "notable-places", "status"] });
    },
    onError: (error) =>
      showToast(error instanceof Error ? error.message : "Operation failed", "error"),
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
          {statusQuery.error instanceof Error ? statusQuery.error.message : "Status unavailable"}
        </Alert>
      )}
      {status?.ok === false && (
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
