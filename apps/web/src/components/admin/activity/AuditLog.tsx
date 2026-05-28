"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
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
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { TableSkeleton } from "../shared/TableSkeleton";
import { ActorCell } from "./ActorCell";

interface AuditEntry {
  id: string;
  actorId: string | null;
  actor: { id: string; name: string; email: string } | null;
  targetId: string | null;
  targetType: string | null;
  action: string;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

// Grouped catalogue of every action emitted by `writeAuditLog` across the
// admin API. Keep this in sync with the call sites under
// `apps/api/src/routes/admin*.ts`.
const ACTION_GROUPS: Array<{ label: string; actions: Array<[action: string, label: string]> }> = [
  {
    label: "Integrations",
    actions: [
      ["integration.config.update", "Config Updated"],
      ["integration.enabled", "Enabled"],
      ["integration.disabled", "Disabled"],
      ["integration.reload", "Reload"],
      ["integration.reload.all", "Reload All"],
      ["integration.config.export", "Config Exported"],
      ["integration.config.import", "Config Imported"],
    ],
  },
  {
    label: "Credentials",
    actions: [
      ["credential.set", "Credential Set"],
      ["credential.delete", "Credential Deleted"],
    ],
  },
  {
    label: "Services",
    actions: [
      ["service.start", "Started"],
      ["service.stop", "Stopped"],
      ["service.restart", "Restarted"],
      ["service.bulk.start", "Bulk Start"],
      ["service.bulk.stop", "Bulk Stop"],
      ["service.bulk.restart", "Bulk Restart"],
      ["service.bulk.recreate", "Bulk Recreate"],
      ["service.bulk.build", "Bulk Build"],
      ["service.selection.update", "Selection Updated"],
      ["service.config.update", "Config Updated"],
      ["service.health_check", "Health Check"],
    ],
  },
  {
    label: "Data",
    actions: [
      ["data.download-osm", "Download OSM"],
      ["data.download-gtfs", "Download GTFS"],
      ["data.download-style", "Download Style"],
      ["data.update", "Update"],
      ["data.convert-overpass", "Convert Overpass"],
      ["data.link", "Link"],
      ["data.clean", "Clean"],
      ["data.generate-api-keys", "Generate API Keys"],
    ],
  },
  {
    label: "Backups",
    actions: [
      ["backup.create", "Create"],
      ["backup.restore", "Restore"],
      ["backup.delete", "Delete"],
    ],
  },
  {
    label: "Settings",
    actions: [
      ["settings.update", "Updated"],
      ["settings.test_email", "Test Email"],
      ["settings.export", "Exported"],
      ["settings.import", "Imported"],
    ],
  },
  {
    label: "Service Store",
    actions: [
      ["store.install", "Install"],
      ["store.update", "Update"],
      ["store.remove", "Remove"],
      ["store.refresh_catalog", "Refresh Catalog"],
      ["store.add_source", "Add Source"],
      ["store.remove_source", "Remove Source"],
    ],
  },
  {
    label: "Jobs",
    actions: [["job.cancel", "Canceled"]],
  },
  {
    label: "Users",
    actions: [
      ["user.create", "Created"],
      ["user.delete", "Deleted"],
      ["user.role.change", "Role Changed"],
      ["user.ban", "Banned"],
      ["user.unban", "Unbanned"],
      ["user.impersonate", "Impersonated"],
      ["user.password.set", "Password Set"],
      ["user.session.revoke", "Session Revoked"],
      ["user.sessions.revoke_all", "All Sessions Revoked"],
    ],
  },
];

const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_GROUPS.flatMap((g) => g.actions),
);

const TARGET_TYPES = [
  "integration",
  "credential",
  "service",
  "data",
  "backup",
  "settings",
  "store",
  "job",
  "user",
];

const DESTRUCTIVE_ACTIONS = new Set([
  "credential.delete",
  "service.stop",
  "service.bulk.stop",
  "backup.delete",
  "store.remove",
  "store.remove_source",
  "job.cancel",
  "user.delete",
  "user.ban",
  "user.session.revoke",
  "user.sessions.revoke_all",
]);

function ActionChip({ action }: { action: string }) {
  const category = action.split(".")[0] ?? "";
  const isDestructive = DESTRUCTIVE_ACTIONS.has(action);
  const isAuth = category === "user" || category === "credential";
  // Destructive → error; auth/credential mutations → warning;
  // every other write → primary; unknown actions → default.
  const color = isDestructive
    ? "error"
    : isAuth
      ? "warning"
      : ACTION_LABELS[action]
        ? "primary"
        : "default";
  return (
    <Chip
      label={ACTION_LABELS[action] ?? action}
      size="small"
      color={color as "error" | "primary" | "warning" | "default"}
      variant="outlined"
    />
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function AuditLog() {
  const env = useEnv();
  const queryClient = useQueryClient();
  const [actionFilter, setActionFilter] = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [targetSearch, setTargetSearch] = useState("");
  const [page, setPage] = useState(0);
  const rowsPerPage = 50;

  const { data, isLoading, isFetching } = useQuery<{ entries: AuditEntry[]; total: number }>({
    queryKey: ["admin", "audit", actionFilter, targetTypeFilter, targetSearch, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(rowsPerPage),
        offset: String(page * rowsPerPage),
      });
      if (actionFilter) params.set("action", actionFilter);
      if (targetTypeFilter) params.set("targetType", targetTypeFilter);
      if (targetSearch.trim()) params.set("targetId", targetSearch.trim());
      const res = await fetch(`${env.apiUrl}/api/admin/audit?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load audit log");
      return res.json();
    },
  });

  function resetFilters() {
    setActionFilter("");
    setTargetTypeFilter("");
    setTargetSearch("");
    setPage(0);
  }

  const hasFilters = !!actionFilter || !!targetTypeFilter || !!targetSearch;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 1,
          flexWrap: "wrap",
        }}
      >
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>Action</InputLabel>
          <Select
            value={actionFilter}
            label="Action"
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(0);
            }}
          >
            <MenuItem value="">All actions</MenuItem>
            {ACTION_GROUPS.flatMap((group) => [
              <ListSubheader key={`hdr-${group.label}`}>{group.label}</ListSubheader>,
              ...group.actions.map(([action, label]) => (
                <MenuItem key={action} value={action}>
                  {label}
                </MenuItem>
              )),
            ])}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Target type</InputLabel>
          <Select
            value={targetTypeFilter}
            label="Target type"
            onChange={(e) => {
              setTargetTypeFilter(e.target.value);
              setPage(0);
            }}
          >
            <MenuItem value="">All types</MenuItem>
            {TARGET_TYPES.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          size="small"
          placeholder="Search by target ID…"
          value={targetSearch}
          onChange={(e) => {
            setTargetSearch(e.target.value);
            setPage(0);
          }}
          sx={{ minWidth: 200 }}
        />

        {hasFilters && <Chip label="Clear filters" size="small" onDelete={resetFilters} />}

        <Box sx={{ flexGrow: 1 }} />

        <Chip label={`${data?.total ?? 0} events`} size="small" variant="outlined" />

        <Tooltip title="Refresh">
          <IconButton
            size="small"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["admin", "audit"] })}
            disabled={isFetching}
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Action</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>Details</TableCell>
              <TableCell>When</TableCell>
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
                    No audit events found
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
                            {entry.targetType}
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
                    <Tooltip title={new Date(entry.createdAt).toLocaleString()}>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {formatRelativeTime(entry.createdAt)}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
      </TableContainer>
      {!!data?.entries.length && (
        <TablePagination
          component="div"
          count={data.total}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          rowsPerPageOptions={[50]}
        />
      )}
    </Stack>
  );
}
