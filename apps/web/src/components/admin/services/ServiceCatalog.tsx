"use client";

import SearchIcon from "@mui/icons-material/Search";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
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
import NextLink from "next/link";
import { useMemo, useState } from "react";
import type { ServiceQuality, ServiceStatus, ServiceSummary } from "@/hooks/useServices";
import { useServicesList } from "@/hooks/useServices";
import { StatusBadge } from "../integrations/StatusBadge";

type QualityFilter = "all" | ServiceQuality;

function statusColor(status: ServiceStatus): "success" | "warning" | "error" | "default" {
  if (status === "running") return "success";
  if (status === "restarting") return "warning";
  if (status === "exited") return "error";
  return "default";
}

function statusLabel(status: ServiceStatus): string {
  if (status === "not-running") return "Not running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function StatusChip({ status }: { status: ServiceStatus }) {
  return (
    <Chip
      label={statusLabel(status)}
      size="small"
      color={statusColor(status)}
      variant={status === "running" ? "filled" : "outlined"}
      sx={{ fontSize: "0.7rem" }}
    />
  );
}

function ProvidesCell({ provides }: { provides: string[] }) {
  if (!provides.length) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {provides.slice(0, 3).map((p) => (
        <Chip
          key={p}
          label={p}
          size="small"
          variant="outlined"
          sx={{ fontSize: "0.65rem", fontFamily: "monospace" }}
        />
      ))}
      {provides.length > 3 && (
        <Tooltip title={provides.slice(3).join(", ")}>
          <Chip
            label={`+${provides.length - 3}`}
            size="small"
            variant="outlined"
            sx={{ fontSize: "0.65rem" }}
          />
        </Tooltip>
      )}
    </Stack>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function SkeletonRows() {
  return (
    <>
      {SKELETON_KEYS.map((k) => (
        <TableRow key={k}>
          <TableCell>
            <Stack gap={0.5}>
              <Skeleton width={120} height={18} />
              <Skeleton width={80} height={14} />
            </Stack>
          </TableCell>
          <TableCell>
            <Skeleton width={60} height={18} />
          </TableCell>
          <TableCell>
            <Skeleton width={80} height={24} />
          </TableCell>
          <TableCell>
            <Skeleton width={100} height={24} />
          </TableCell>
          <TableCell>
            <Skeleton width={80} height={24} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function filterServices(
  services: ServiceSummary[],
  search: string,
  quality: QualityFilter,
): ServiceSummary[] {
  const q = search.trim().toLowerCase();
  return services.filter((s) => {
    if (quality !== "all") {
      if (quality === "community" && s.quality === "built-in") return false;
      if (quality === "built-in" && s.quality !== "built-in") return false;
    }
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.description?.toLowerCase().includes(q) ?? false) ||
      s.provides.some((p) => p.toLowerCase().includes(q))
    );
  });
}

export function ServiceCatalog() {
  const { data, isLoading, isError, refetch } = useServicesList();
  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState<QualityFilter>("all");

  const services = data?.services ?? [];
  const summary = data?.summary;
  const filtered = useMemo(
    () => filterServices(services, search, quality),
    [services, search, quality],
  );

  return (
    <Stack gap={2}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        gap={1}
      >
        <Stack direction="row" alignItems="center" gap={1}>
          <StorageIcon sx={{ color: "text.secondary" }} />
          <Typography variant="h6" fontWeight={700}>
            Service Catalog
          </Typography>
          {!isLoading && summary && (
            <Stack direction="row" gap={0.5}>
              <Chip
                label={`${summary.total} total`}
                size="small"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
              <Chip
                label={`${summary.running} running`}
                size="small"
                color="success"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
              <Chip
                label={`${summary.stopped} stopped`}
                size="small"
                color="default"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
            </Stack>
          )}
        </Stack>
        {isLoading && <CircularProgress size={20} />}
      </Stack>

      <Stack direction="row" gap={1.5} flexWrap="wrap">
        <TextField
          size="small"
          placeholder="Search by name, ID, or capability…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ minWidth: 280 }}
        />
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <Select
            value={quality}
            onChange={(e) => setQuality(e.target.value as QualityFilter)}
            displayEmpty
          >
            <MenuItem value="all">All quality tiers</MenuItem>
            <MenuItem value="built-in">Built-in</MenuItem>
            <MenuItem value="community">Community</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      {isError && (
        <Alert
          severity="error"
          action={
            <Typography
              variant="body2"
              sx={{ cursor: "pointer", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Retry
            </Typography>
          }
        >
          Failed to load services. The backend may not be running yet.
        </Alert>
      )}

      <Paper variant="outlined">
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Service</TableCell>
                <TableCell>Version</TableCell>
                <TableCell>Quality</TableCell>
                <TableCell>Provides</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <SkeletonRows />
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Box py={3} textAlign="center">
                      <Typography variant="body2" color="text.secondary">
                        {services.length === 0
                          ? "No services registered yet."
                          : "No services match the current filters."}
                      </Typography>
                    </Box>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((svc) => (
                  <TableRow
                    key={svc.id}
                    hover
                    component={NextLink}
                    href={`/admin/services/${svc.id}`}
                    sx={{
                      textDecoration: "none",
                      cursor: "pointer",
                      "&:last-child td": { borderBottom: 0 },
                    }}
                  >
                    <TableCell>
                      <Stack gap={0.25}>
                        <Typography variant="body2" fontWeight={600}>
                          {svc.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                          {svc.id}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
                        {svc.version}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <StatusBadge quality={svc.quality} />
                    </TableCell>
                    <TableCell>
                      <ProvidesCell provides={svc.provides} />
                    </TableCell>
                    <TableCell>
                      <StatusChip status={svc.status} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {!isLoading && !isError && filtered.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          Showing {filtered.length} of {services.length} services
        </Typography>
      )}
    </Stack>
  );
}
