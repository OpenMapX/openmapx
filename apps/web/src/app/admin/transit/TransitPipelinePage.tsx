"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { AdminPageHeader } from "@/components/admin/shared/AdminPageHeader";
import { useTransitState } from "@/lib/admin/transitHooks";
import { CurrentJobCard } from "./CurrentJobCard";
import { FeedsBreakdownChart } from "./FeedsBreakdownChart";
import { FeedsTable } from "./FeedsTable";
import { LockfileCard } from "./LockfileCard";
import { ProviderHealthTable } from "./ProviderHealthTable";
import { RecentJobsTable } from "./RecentJobsTable";

export function TransitPipelinePage() {
  const queryClient = useQueryClient();
  const { data: state, isLoading, isError, refetch, isFetching } = useTransitState();

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <AdminPageHeader
          title="Transit pipeline"
          subtitle="Transitous sync · feed state · job history · provider health"
          actions={
            <Tooltip title="Refresh all">
              <IconButton
                size="small"
                onClick={() => {
                  void refetch();
                  void queryClient.invalidateQueries({ queryKey: ["admin", "transit"] });
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
          Failed to load transit pipeline state. Check the BFF + data-manager logs.
        </Alert>
      )}
      {state && (
        <Stack spacing={3}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <LockfileCard state={state} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <CurrentJobCard state={state} />
            </Box>
          </Stack>

          <FeedsBreakdownChart state={state} />
          <RecentJobsTable />
          <FeedsTable state={state} />
          <ProviderHealthTable />
        </Stack>
      )}
    </Box>
  );
}
