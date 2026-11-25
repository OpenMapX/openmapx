"use client";

import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  getExportAdminAuditLogUrl,
  listAdminAuditLog,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import type { AuditAction, AuditTargetType } from "@openmapx/core/api-contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Menu from "@/components/ui/Menu";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { browserAdminApiBase } from "@/lib/admin/browserAdminApiBase";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAuditActionLabel } from "../shared/auditActionLabel";
import { TableSkeleton } from "../shared/TableSkeleton";
import { useServerPagination } from "../shared/tableHooks";
import { ActorCell } from "./ActorCell";
import { useActivityClient } from "./activityQueries";
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_TARGET_TYPES,
  DESTRUCTIVE_AUDIT_ACTIONS,
  KNOWN_AUDIT_ACTIONS,
} from "./auditCatalog";

function ActionChip({ action }: { action: string }) {
  const actionLabel = useAuditActionLabel();
  const category = action.split(".")[0] ?? "";
  const isDestructive = DESTRUCTIVE_AUDIT_ACTIONS.has(action);
  const isAuth = category === "user" || category === "credential";
  // Destructive → error; auth/credential mutations → warning;
  // every other write → primary; unknown actions → default.
  const color = isDestructive
    ? "error"
    : isAuth
      ? "warning"
      : KNOWN_AUDIT_ACTIONS.has(action)
        ? "primary"
        : "default";
  return (
    <Chip
      label={actionLabel(action)}
      size="small"
      color={color as "error" | "primary" | "warning" | "default"}
      variant="outlined"
    />
  );
}

export function AuditLog() {
  const t = useTranslations("adminActivity.audit");
  const actionLabel = useAuditActionLabel();
  const { apiUrl, client } = useActivityClient();
  const dtf = useDateTimeFormat();
  const queryClient = useQueryClient();
  const [actionFilter, setActionFilter] = useState<AuditAction | "">("");
  const [targetTypeFilter, setTargetTypeFilter] = useState<AuditTargetType | "">("");
  const [targetSearch, setTargetSearch] = useState("");
  const { page, rowsPerPage, offset, setPage, paginationProps } = useServerPagination(50);

  const filters = {
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(targetTypeFilter ? { targetType: targetTypeFilter } : {}),
    ...(targetSearch.trim() ? { targetId: targetSearch.trim() } : {}),
  };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["admin", "audit", actionFilter, targetTypeFilter, targetSearch, page],
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(
        await listAdminAuditLog(
          { limit: String(rowsPerPage), offset: String(offset), ...filters },
          { client, signal },
        ),
      ),
  });

  function resetFilters() {
    setActionFilter("");
    setTargetTypeFilter("");
    setTargetSearch("");
    setPage(0);
  }

  const hasFilters = !!actionFilter || !!targetTypeFilter || !!targetSearch;

  const [exportAnchor, setExportAnchor] = useState<null | HTMLElement>(null);

  function exportUrl(format: "csv" | "json"): string {
    return new URL(getExportAdminAuditLogUrl({ format, ...filters }), browserAdminApiBase(apiUrl))
      .href;
  }

  function handleExport(format: "csv" | "json") {
    setExportAnchor(null);
    // Top-level navigation to the download endpoint sends the admin session
    // cookie and lets the server-set Content-Disposition drive the download —
    // no client-side serialization of the rows here.
    const a = document.createElement("a");
    a.href = exportUrl(format);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Select keys hold no `-` or `.`, so `data-manager-job` is selected as `data_manager_job`. */
  const targetTypeLabel = (type: string) =>
    t("targetTypeOption", { type: type.replaceAll(/[.-]/g, "_") });

  return (
    <AdminTableSurface
      toolbar={
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 1,
            flexWrap: "wrap",
          }}
        >
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>{t("action")}</InputLabel>
            <Select
              value={actionFilter}
              label={t("action")}
              onChange={(e) => {
                setActionFilter(e.target.value as AuditAction | "");
                setPage(0);
              }}
            >
              <MenuItem value="">{t("allActions")}</MenuItem>
              {AUDIT_ACTION_GROUPS.flatMap((group) => [
                <ListSubheader key={`hdr-${group.group}`}>
                  {t("actionGroup", { group: group.group })}
                </ListSubheader>,
                ...group.actions.map((action) => (
                  <MenuItem key={action} value={action}>
                    {actionLabel(action)}
                  </MenuItem>
                )),
              ])}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>{t("targetType")}</InputLabel>
            <Select
              value={targetTypeFilter}
              label={t("targetType")}
              onChange={(e) => {
                setTargetTypeFilter(e.target.value as AuditTargetType | "");
                setPage(0);
              }}
            >
              <MenuItem value="">{t("allTypes")}</MenuItem>
              {AUDIT_TARGET_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {targetTypeLabel(type)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            size="small"
            placeholder={t("searchTarget")}
            value={targetSearch}
            onChange={(e) => {
              setTargetSearch(e.target.value);
              setPage(0);
            }}
            sx={{ minWidth: 200 }}
          />

          {hasFilters && <Chip label={t("clearFilters")} size="small" onDelete={resetFilters} />}

          <Box sx={{ flexGrow: 1 }} />

          <Chip label={t("events", { count: data?.total ?? 0 })} size="small" variant="outlined" />

          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon fontSize="small" />}
            onClick={(e) => setExportAnchor(e.currentTarget)}
          >
            {t("export")}
          </Button>
          <Menu anchorEl={exportAnchor} open={!!exportAnchor} onClose={() => setExportAnchor(null)}>
            <MenuItem onClick={() => handleExport("csv")}>{t("exportCsv")}</MenuItem>
            <MenuItem onClick={() => handleExport("json")}>{t("exportJson")}</MenuItem>
          </Menu>

          <Tooltip title={t("refresh")}>
            <IconButton
              size="small"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ["admin", "audit"] })}
              disabled={isFetching}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      }
    >
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t("action")}</TableCell>
              <TableCell>{t("target")}</TableCell>
              <TableCell>{t("actor")}</TableCell>
              <TableCell>{t("details")}</TableCell>
              <TableCell>{t("when")}</TableCell>
            </TableRow>
          </TableHead>
          {isLoading ? (
            <TableSkeleton rows={6} columns={5} />
          ) : !data?.entries.length ? (
            <TableBody>
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("empty")}
                  </Typography>
                </TableCell>
              </TableRow>
            </TableBody>
          ) : (
            <TableBody>
              {data.entries.map((entry) => (
                <TableRow key={entry.id} hover>
                  <TableCell>
                    <ActionChip action={entry.action} />
                  </TableCell>
                  <TableCell>
                    {entry.targetId ? (
                      <Stack>
                        {entry.targetType && (
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.secondary",
                            }}
                          >
                            {targetTypeLabel(entry.targetType)}
                          </Typography>
                        )}
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: "monospace",
                            fontSize: "0.75rem",
                          }}
                        >
                          {entry.targetId.length > 32
                            ? `${entry.targetId.slice(0, 16)}…${entry.targetId.slice(-8)}`
                            : entry.targetId}
                        </Typography>
                      </Stack>
                    ) : (
                      <Typography
                        variant="body2"
                        sx={{
                          color: "text.disabled",
                        }}
                      >
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <ActorCell actorId={entry.actorId} actor={entry.actor} />
                  </TableCell>
                  <TableCell>
                    {entry.details && Object.keys(entry.details).length > 0 ? (
                      <Tooltip title={JSON.stringify(entry.details, null, 2)}>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            cursor: "default",
                          }}
                        >
                          {Object.entries(entry.details)
                            .slice(0, 2)
                            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                            .join(", ")}
                          {Object.keys(entry.details).length > 2 ? " …" : ""}
                        </Typography>
                      </Tooltip>
                    ) : (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.disabled",
                        }}
                      >
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={dtf.dateTime(entry.createdAt)}>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {dtf.recent(entry.createdAt)}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
      </TableContainer>
      <AdminTablePagination
        {...paginationProps}
        count={data?.total ?? 0}
        rowsPerPageOptions={[50]}
        hideSinglePage={false}
      />
    </AdminTableSurface>
  );
}
