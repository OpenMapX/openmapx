"use client";

import RestartAltIcon from "@mui/icons-material/RestartAlt";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { AdminTablePagination } from "@/components/admin/shared/AdminTablePagination";
import { AdminTableSurface } from "@/components/admin/shared/AdminTableSurface";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import { useClientPagination } from "@/components/admin/shared/tableHooks";
import { useProviderHealth, useResetProvider } from "@/lib/admin/transitHooks";

function formatPercent(rate: number | undefined): string {
  if (rate === undefined || rate === null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(0)}%`;
}

function isDisabled(disabledUntil: string | undefined): boolean {
  if (!disabledUntil) return false;
  const t = new Date(disabledUntil).getTime();
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

function failureRateColor(rate: number | undefined): "default" | "success" | "warning" | "error" {
  if (rate === undefined) return "default";
  if (rate >= 0.5) return "error";
  if (rate >= 0.1) return "warning";
  return "success";
}

export function ProviderHealthTable() {
  const showToast = useAdminToast();
  const { data, isLoading, isError } = useProviderHealth();
  const resetMutation = useResetProvider();
  const providers = data?.providers ?? [];
  const { paged, paginationProps } = useClientPagination(providers, 25);

  const onReset = (providerId: string) => {
    resetMutation.mutate(providerId, {
      onSuccess: () => showToast(`Provider "${providerId}" reset`, "success"),
      onError: (err) =>
        showToast(err instanceof Error ? err.message : `Failed to reset ${providerId}`, "error"),
    });
  };

  return (
    <AdminTableSurface
      title="Provider health"
      description="Sliding-window failure rate · EMA latency · cooldown state"
      pagination={<AdminTablePagination {...paginationProps} />}
    >
      {isLoading ? (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            py: 3,
          }}
        >
          <CircularProgress size={22} />
        </Box>
      ) : isError ? (
        <Typography variant="body2" color="error">
          Failed to load provider health.
        </Typography>
      ) : !data || data.providers.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          No providers recorded yet. Health tracking populates on the first request to each
          provider.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Provider</TableCell>
                <TableCell align="right">OK</TableCell>
                <TableCell align="right">Fail</TableCell>
                <TableCell align="right">Window fail %</TableCell>
                <TableCell align="right">EMA latency</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {paged.map((p) => {
                const disabled = isDisabled(p.disabledUntil);
                return (
                  <TableRow key={p.id} hover>
                    <TableCell>
                      <Stack spacing={0.25}>
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: "monospace",
                          }}
                        >
                          {p.id}
                        </Typography>
                        {p.lastFailureReason && (
                          <Tooltip title={p.lastFailureReason}>
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                                maxWidth: 240,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                cursor: "help",
                              }}
                            >
                              last error: {p.lastFailureReason}
                            </Typography>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{p.success.toLocaleString()}</TableCell>
                    <TableCell align="right">{p.failure.toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Chip
                        size="small"
                        variant="outlined"
                        color={failureRateColor(p.windowFailureRate)}
                        label={formatPercent(p.windowFailureRate)}
                      />
                    </TableCell>
                    <TableCell align="right">
                      {Number.isFinite(p.emaLatencyMs) ? `${Math.round(p.emaLatencyMs)} ms` : "—"}
                    </TableCell>
                    <TableCell>
                      {disabled ? (
                        <Tooltip title={p.disabledReason ?? "Auto-disabled (cooldown)"}>
                          <Chip
                            size="small"
                            color="error"
                            label={`disabled until ${new Date(
                              p.disabledUntil ?? "",
                            ).toLocaleTimeString()}`}
                          />
                        </Tooltip>
                      ) : (
                        <Chip size="small" color="success" variant="outlined" label="active" />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        startIcon={<RestartAltIcon fontSize="small" />}
                        onClick={() => onReset(p.id)}
                        disabled={resetMutation.isPending}
                      >
                        Reset
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </AdminTableSurface>
  );
}
