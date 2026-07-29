"use client";

import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import RefreshIcon from "@mui/icons-material/Refresh";
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
import Tooltip from "@mui/material/Tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { ErrorState } from "../shared/ErrorState";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSkeleton } from "../shared/TableSkeleton";
import { useClientPagination } from "../shared/tableHooks";

interface CacheNamespace {
  namespace: string;
  keyCount: number;
}

interface CacheListResponse {
  namespaces: CacheNamespace[];
}

const CACHE_QUERY_KEY = ["admin", "cache"] as const;

// A clear target: either a single namespace, or every app-owned prefix ("all").
type ClearTarget = { kind: "all" } | { kind: "namespace"; namespace: string };

export function CacheManager() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const showToast = useAdminToast();
  const [target, setTarget] = useState<ClearTarget | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<CacheListResponse>({
    queryKey: CACHE_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/cache`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cache");
      return res.json();
    },
  });

  const clearMutation = useMutation({
    mutationFn: async (t: ClearTarget) => {
      const res = await fetch(`${apiUrl}/api/admin/cache/clear`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(t.kind === "all" ? {} : { namespace: t.namespace }),
      });
      if (!res.ok) throw new Error("Failed to clear cache");
      return res.json() as Promise<{ deleted: number }>;
    },
    onSuccess: (result) => {
      showToast(`Cleared ${result.deleted} cache ${result.deleted === 1 ? "key" : "keys"}`);
      qc.invalidateQueries({ queryKey: CACHE_QUERY_KEY });
    },
    onError: () => showToast("Failed to clear cache", "error"),
    onSettled: () => setTarget(null),
  });

  const namespaces = data?.namespaces ?? [];
  const { paged, paginationProps } = useClientPagination(namespaces);
  const confirmMessage =
    target?.kind === "namespace"
      ? `Clear all cached keys under "${target.namespace}"? This cannot be undone.`
      : "Clear the entire application cache (all integration and API caches)? This cannot be undone.";

  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader
        title="Cache"
        subtitle="Inspect and clear the application cache"
        actions={
          <>
            <Tooltip title="Refresh">
              <IconButton onClick={() => refetch()} size="small">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Button
              variant="outlined"
              color="error"
              size="small"
              startIcon={<DeleteSweepIcon />}
              disabled={namespaces.length === 0 || clearMutation.isPending}
              onClick={() => setTarget({ kind: "all" })}
            >
              Clear all
            </Button>
          </>
        }
      />

      {isError ? (
        <ErrorState message="Failed to load the cache." onRetry={() => refetch()} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Namespace</TableCell>
                <TableCell align="right">Keys</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            {isLoading ? (
              <TableSkeleton rows={5} columns={3} />
            ) : (
              <TableBody>
                {namespaces.length === 0 ? (
                  <TableEmptyState colSpan={3} message="No cached data found" />
                ) : (
                  paged.map((ns) => (
                    <TableRow key={ns.namespace} hover>
                      <TableCell sx={{ fontFamily: "monospace" }}>{ns.namespace}</TableCell>
                      <TableCell align="right">{ns.keyCount}</TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          color="error"
                          disabled={clearMutation.isPending}
                          onClick={() => setTarget({ kind: "namespace", namespace: ns.namespace })}
                        >
                          Clear
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
        title="Clear cache"
        message={confirmMessage}
        confirmLabel="Clear"
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
