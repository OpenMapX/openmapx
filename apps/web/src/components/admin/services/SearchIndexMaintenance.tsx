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
import { useState } from "react";
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
      if (!response.ok) throw new Error(body.error ?? "Failed to load search index status");
      return body;
    },
    refetchInterval: (query) => (query.state.data?.building ? 10_000 : 60_000),
  });
  const status = statusQuery.data;
  const effectiveRegion = resolveSearchIndexRegion(region, status);
  const operation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${apiUrl}/api/admin/services/data/action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "search-index-build", region: effectiveRegion }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
      };
      if (!response.ok || !body.jobId) throw new Error(body.error ?? "Failed to queue index build");
      return body.jobId;
    },
    onSuccess: (jobId) => {
      showToast(`Queued search-index build (${jobId})`);
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "search-index", "status"] });
    },
    onError: (error) =>
      showToast(error instanceof Error ? error.message : "Operation failed", "error"),
  });

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ gap: 2, alignItems: { md: "center" } }}>
        <Box sx={{ flexGrow: 1 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
            <SearchIcon color="primary" />
            <Typography component="h2" variant="h6">
              OSM code and alias search
            </Typography>
            {(status?.status || status?.building) && (
              <Chip
                label={status?.building ? "building" : status.status}
                color={
                  status?.status === "failed" ? "error" : status?.stale ? "warning" : "primary"
                }
                variant="outlined"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Build the regional OSM alias, reference, and conservative acronym index atomically.
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
          No local OSM alias index is published. Airport and configured transit-code search remain
          available.
        </Alert>
      )}
      {status?.stale && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          A newer OSM PBF is available. The previous index remains searchable until rebuilt.
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
            ["Region", status.region ?? "—"],
            ["Places", status.placeCount?.toLocaleString() ?? "—"],
            ["Terms", status.termCount?.toLocaleString() ?? "—"],
            ["Epoch", status.epoch ?? "—"],
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

      <Stack
        direction={{ xs: "column", sm: "row" }}
        sx={{ gap: 1, mt: 2, alignItems: { sm: "center" } }}
      >
        <TextField
          label="Region"
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
          {status?.stale ? "Rebuild index" : "Build index"}
        </Button>
      </Stack>

      <ConfirmDialog
        open={confirmOpen}
        title="Build OSM search index"
        message={`Build and atomically publish the OSM code and alias index for "${effectiveRegion}"? This can be CPU-, disk-, and database-intensive.`}
        confirmLabel="Start build"
        loading={operation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => operation.mutate()}
      />
    </Paper>
  );
}
