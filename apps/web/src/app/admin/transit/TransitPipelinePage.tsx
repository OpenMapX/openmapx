"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useQueryClient } from "@tanstack/react-query";
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
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Transit pipeline
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Transitous sync · feed state · job history · provider health
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
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
      </Stack>

      {isLoading && (
        <Box display="flex" justifyContent="center" py={6}>
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
