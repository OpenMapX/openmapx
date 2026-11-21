"use client";

import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import type { ApiClient } from "@openmapx/core";
import {
  clearAdminCache,
  listAdminCacheNamespaces,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import { isAppCachePattern } from "@openmapx/core/cache-namespaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { useActivityClient } from "../activity/activityQueries";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { ErrorState } from "../shared/ErrorState";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSkeleton } from "../shared/TableSkeleton";
import { useClientPagination } from "../shared/tableHooks";

const CACHE_QUERY_KEY = ["admin", "cache"] as const;

// A clear target: either a single namespace, or every app-owned prefix ("all").
type ClearTarget =
  | { kind: "all" }
  | { kind: "namespace"; namespace: string }
  | { kind: "pattern"; pattern: string; estimatedCount: number };

export function CacheManager() {
  const { apiUrl, client } = useActivityClient();
  return <CacheManagerSession key={apiUrl} apiUrl={apiUrl} client={client} />;
}
function CacheManagerSession({ apiUrl, client }: { apiUrl: string; client: ApiClient }) {
  const t = useTranslations("adminSystem.cache");
  const format = useAdminFormat();
  const qc = useQueryClient();
  const showToast = useAdminToast();
  const [pattern, setPattern] = useState("");
  const [preview, setPreview] = useState<{ pattern: string; estimatedCount: number } | null>(null);
  const patternValid = isAppCachePattern(pattern);
  const [target, setTarget] = useState<ClearTarget | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...CACHE_QUERY_KEY, apiUrl],
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(await listAdminCacheNamespaces({ client, signal })),
  });

  const previewMutation = useMutation({
    mutationFn: async (captured: string) => {
      const result = unwrapAdminResponse(
        await clearAdminCache({ pattern: captured, dryRun: true }, { client }),
      );
      if (!("estimatedCount" in result)) throw new Error("Preview deleted keys");
      return { pattern: captured, estimatedCount: result.estimatedCount };
    },
    onSuccess: setPreview,
  });
  const clearMutation = useMutation({
    mutationFn: async (clear: ClearTarget) => {
      const result = unwrapAdminResponse(
        await clearAdminCache(
          clear.kind === "all"
            ? {}
            : clear.kind === "pattern"
              ? { pattern: clear.pattern }
              : { namespace: clear.namespace },
          { client },
        ),
      );
      if (!("deleted" in result)) throw new Error("Clear returned a preview");
      return result;
    },
    onSuccess: (result) => {
      showToast(t("cleared", { count: result.deleted }));
      setPreview(null);
      void qc.invalidateQueries({ queryKey: [...CACHE_QUERY_KEY, apiUrl] });
    },
    onError: () => showToast(t("clearFailed"), "error"),
    onSettled: () => setTarget(null),
  });

  const namespaces = data?.namespaces ?? [];
  const { paged, paginationProps } = useClientPagination(namespaces);
  const confirmMessage =
    target?.kind === "pattern"
      ? t("confirmPattern", { pattern: target.pattern, count: target.estimatedCount })
      : target?.kind === "namespace"
        ? t("confirmNamespace", { namespace: target.namespace })
        : t("confirmAll");

  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <Tooltip title={t("refresh")}>
              <IconButton onClick={() => refetch()} size="small">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Button
              aria-label={t("clearAllLabel")}
              variant="outlined"
              color="error"
              size="small"
              startIcon={<DeleteSweepIcon />}
              disabled={namespaces.length === 0 || clearMutation.isPending}
              onClick={() => setTarget({ kind: "all" })}
            >
              {t("clearAll")}
            </Button>
          </>
        }
      />

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack sx={{ gap: 2 }}>
          <TextField
            label={t("pattern")}
            value={pattern}
            onChange={(event) => {
              setPattern(event.target.value);
              setPreview(null);
              previewMutation.reset();
            }}
            helperText={t("patternHelp", { max: 256 })}
            placeholder="int:geocoding:*"
            size="small"
          />
          <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
            <Button
              disabled={!patternValid || previewMutation.isPending || clearMutation.isPending}
              onClick={() => previewMutation.mutate(pattern)}
            >
              {t("previewPattern")}
            </Button>
            <Button
              color="error"
              disabled={!preview || preview.pattern !== pattern || clearMutation.isPending}
              onClick={() => {
                if (preview && preview.pattern === pattern)
                  setTarget({ kind: "pattern", ...preview });
              }}
            >
              {t("clearPreviewed")}
            </Button>
          </Stack>
          {previewMutation.isError && (
            <Alert severity="error">
              {adminErrorText(previewMutation.error, t("previewFailed"))}
            </Alert>
          )}
          {preview && preview.pattern === pattern && (
            <Alert severity="info">
              {t("previewResult", { count: preview.estimatedCount, pattern: preview.pattern })}
            </Alert>
          )}
        </Stack>
      </Paper>
      {isError ? (
        <ErrorState message={t("loadFailed")} onRetry={() => refetch()} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("namespace")}</TableCell>
                <TableCell align="right">{t("keys")}</TableCell>
                <TableCell align="right">{t("actions")}</TableCell>
              </TableRow>
            </TableHead>
            {isLoading ? (
              <TableSkeleton rows={5} columns={3} />
            ) : (
              <TableBody>
                {namespaces.length === 0 ? (
                  <TableEmptyState colSpan={3} message={t("empty")} />
                ) : (
                  paged.map((ns) => (
                    <TableRow key={ns.namespace} hover>
                      <TableCell sx={{ fontFamily: "monospace" }}>{ns.namespace}</TableCell>
                      <TableCell align="right">{format.number(ns.keyCount)}</TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          color="error"
                          disabled={clearMutation.isPending}
                          onClick={() => setTarget({ kind: "namespace", namespace: ns.namespace })}
                        >
                          {t("clear")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            )}
          </Table>
          <AdminTablePagination {...paginationProps} />
        </TableContainer>
      )}

      <ConfirmDialog
        open={target !== null}
        title={t("clearTitle")}
        message={confirmMessage}
        confirmLabel={t("clear")}
        confirmColor="error"
        loading={clearMutation.isPending}
        onConfirm={() => {
          if (target) clearMutation.mutate(target);
        }}
        onCancel={() => setTarget(null)}
      />
    </Stack>
  );
}
