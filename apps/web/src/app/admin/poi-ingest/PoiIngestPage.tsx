"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
import { usePoiIngestState } from "@/lib/admin/poiIngestHooks";
import { InflightCard } from "./InflightCard";
import { OverviewCard } from "./OverviewCard";
import { PoiSourceTable } from "./PoiSourceTable";
import { RecentFailuresTable } from "./RecentFailuresTable";
import { SourceDetailDrawer } from "./SourceDetailDrawer";

export function PoiIngestPage() {
  const queryClient = useQueryClient();
  const { data: state, isLoading, isError, refetch, isFetching } = usePoiIngestState();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const drift = state?.drift;
  const driftMismatch = state?.registryCountMatchesUpstream === false;

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <AdminPageHeader
          title="POI ingest"
          subtitle="EV charging · parking · per-source PostGIS ingest"
          actions={
            <Tooltip title="Refresh all">
              <IconButton
                size="small"
                onClick={() => {
                  void refetch();
                  void queryClient.invalidateQueries({ queryKey: ["admin", "poi-ingest"] });
                }}
                disabled={isFetching}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          }
        />
      </Box>
      {isLoading && (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            py: 6,
          }}
        >
          <CircularProgress />
        </Box>
      )}
      {isError && (
        <Alert severity="error">
          Failed to load POI ingest state. Check the BFF + data-manager logs.
        </Alert>
      )}
      {state && (
        <Stack spacing={2}>
          {driftMismatch && (
            <Alert severity="warning">
              POI source registry differs between apps/api and data-manager
              {drift?.reason ? `: ${drift.reason}` : "."}
              {drift?.local && drift?.upstream && (
                <Box component="span" sx={{ display: "block", mt: 0.5, fontSize: 12 }}>
                  local {drift.local.count} ({drift.local.hash.slice(0, 8)}) · upstream{" "}
                  {drift.upstream.count} ({drift.upstream.hash.slice(0, 8)})
                </Box>
              )}
            </Alert>
          )}

          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <OverviewCard state={state} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <InflightCard state={state} />
            </Box>
          </Stack>

          <RecentFailuresTable state={state} onSelect={setSelectedId} />

          <PoiSourceTable state={state} onSelect={setSelectedId} />
        </Stack>
      )}
      <SourceDetailDrawer sourceId={selectedId} onClose={() => setSelectedId(null)} />
    </Box>
  );
}
