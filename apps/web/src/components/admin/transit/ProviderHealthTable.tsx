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
import { useTranslations } from "next-intl";
import { AdminTablePagination } from "@/components/admin/shared/AdminTablePagination";
import { AdminTableSurface } from "@/components/admin/shared/AdminTableSurface";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import { useClientPagination } from "@/components/admin/shared/tableHooks";
import { type AdminFormatters, useAdminFormat } from "@/lib/admin/adminFormat";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import {
  type ProviderHealthEntry,
  useProviderHealth,
  useResetProvider,
} from "@/lib/admin/transitHooks";

function formatRate(rate: number | null, format: AdminFormatters): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return format.percent(rate);
}

function failureRateColor(rate: number | null): "default" | "success" | "warning" | "error" {
  if (rate === null) return "default";
  if (rate >= 0.5) return "error";
  if (rate >= 0.1) return "warning";
  return "success";
}

function formatClock(at: string | null | undefined, format: AdminFormatters): string | null {
  if (!at) return null;
  const time = new Date(at);
  return Number.isFinite(time.getTime()) ? format.time(time) : null;
}

function StateChip({ provider }: { provider: ProviderHealthEntry }) {
  const t = useTranslations("adminTransit");
  const format = useAdminFormat();
  const retryAt = formatClock(provider.retryAt, format);
  switch (provider.state) {
    case "healthy":
      return <Chip size="small" color="success" variant="outlined" label={t("healthy")} />;
    case "degraded":
      return (
        <Tooltip title={t("recentCountedFailuresRequestsStill")}>
          <Chip size="small" color="warning" variant="outlined" label={t("degraded")} />
        </Tooltip>
      );
    case "open":
      return (
        <Tooltip title={t("circuitOpenRequestsSkipThis")}>
          <Chip
            size="small"
            color="error"
            label={retryAt ? t("openUntil", { retryAt }) : t("circuitOpen")}
          />
        </Tooltip>
      );
    case "half-open":
      return (
        <Tooltip title={t("cooldownEndedTheNextRequest")}>
          <Chip size="small" color="warning" label={t("halfOpen")} />
        </Tooltip>
      );
  }
}

export function ProviderHealthTable() {
  const t = useTranslations("adminTransit");
  const format = useAdminFormat();
  const showToast = useAdminToast();
  const { data, isLoading, isError } = useProviderHealth();
  const resetMutation = useResetProvider();
  const providers = data?.providers ?? [];
  const { paged, paginationProps } = useClientPagination(providers, 25);

  const onReset = (providerId: string) => {
    resetMutation.mutate(providerId, {
      onSuccess: () => showToast(t("providerReset", { providerId }), "success"),
      onError: (err) =>
        showToast(adminErrorText(err, t("providerResetFailed", { providerId })), "error"),
    });
  };

  return (
    <AdminTableSurface
      title={t("providerHealth")}
      description={t("slidingWindowFailureRateEma")}
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
          {t("failedToLoadProviderHealth")}
        </Typography>
      ) : !data || data.providers.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("noProvidersRecordedYetHealth")}
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("provider")}</TableCell>
                <TableCell align="right">{t("ok")}</TableCell>
                <TableCell align="right">{t("fail")}</TableCell>
                <TableCell align="right">{t("windowFail")}</TableCell>
                <TableCell align="right">{t("emaLatency")}</TableCell>
                <TableCell>{t("status")}</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {paged.map((p) => {
                const lastError = p.lastOperatorMessage || p.lastFailureOutcome;
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
                        {lastError && (
                          <Tooltip title={lastError}>
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
                              {t("lastError", { error: lastError })}
                            </Typography>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{format.number(p.successCount)}</TableCell>
                    <TableCell align="right">{format.number(p.failureCount)}</TableCell>
                    <TableCell align="right">
                      <Chip
                        size="small"
                        variant="outlined"
                        color={failureRateColor(p.windowFailureRate)}
                        label={formatRate(p.windowFailureRate, format)}
                      />
                    </TableCell>
                    <TableCell align="right">
                      {Number.isFinite(p.emaLatencyMs) ? format.duration(p.emaLatencyMs) : "—"}
                    </TableCell>
                    <TableCell>
                      <StateChip provider={p} />
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        startIcon={<RestartAltIcon fontSize="small" />}
                        onClick={() => onReset(p.id)}
                        disabled={resetMutation.isPending}
                      >
                        {t("reset")}
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
