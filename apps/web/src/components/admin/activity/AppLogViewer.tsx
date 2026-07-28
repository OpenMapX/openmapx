"use client";

import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useServerPagination } from "../shared/tableHooks";

interface AppLogEntry {
  id: number;
  level: string;
  source: string;
  msg: string;
  time: number;
  metadata?: Record<string, unknown>;
}

const LEVEL_COLORS: Record<string, string> = {
  trace: "#9e9e9e",
  debug: "#64b5f6",
  info: "#4caf50",
  warn: "#ff9800",
  error: "#f44336",
  fatal: "#9c27b0",
};

const LEVEL_OPTIONS = ["all", "debug", "info", "warn", "error"];

const TIME_RANGES: Record<string, number | undefined> = {
  "last 15m": 15 * 60 * 1000,
  "last 1h": 60 * 60 * 1000,
  "last 6h": 6 * 60 * 60 * 1000,
  "last 24h": 24 * 60 * 60 * 1000,
  all: undefined,
};

function LogLine({ entry }: { entry: AppLogEntry }) {
  const color = LEVEL_COLORS[entry.level] ?? "#9e9e9e";
  const ts = new Date(entry.time).toLocaleTimeString("en-US", { hour12: false });

  return (
    <Box
      sx={{
        display: "flex",
        gap: 1,
        py: 0.25,
        px: 1,
        "&:hover": { bgcolor: "action.hover" },
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 1.6,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography
        component="span"
        sx={{ color: "grey.500", fontSize: 12, fontFamily: "monospace", flexShrink: 0 }}
      >
        {ts}
      </Typography>
      <Typography
        component="span"
        sx={{ color, fontWeight: 700, fontSize: 11, flexShrink: 0, width: 44 }}
      >
        {entry.level.toUpperCase()}
      </Typography>
      <Typography
        component="span"
        sx={{
          color: "#71D674",
          fontSize: 11,
          flexShrink: 0,
          width: 140,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.source}
      </Typography>
      <Typography
        component="span"
        sx={{ color: "grey.100", fontSize: 12, fontFamily: "monospace", flexGrow: 1 }}
      >
        {entry.msg}
        {entry.metadata && Object.keys(entry.metadata).length > 0 && (
          <Box component="span" sx={{ color: "grey.500", ml: 1 }}>
            {JSON.stringify(entry.metadata)}
          </Box>
        )}
      </Typography>
    </Box>
  );
}

export function AppLogViewer() {
  const env = useEnv();
  const qc = useQueryClient();
  const [levelFilter, setLevelFilter] = useState("info");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [timeRange, setTimeRange] = useState("last 1h");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { page, rowsPerPage, offset, setPage, paginationProps } = useServerPagination(100);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sinceMs = TIME_RANGES[timeRange];
  const since = sinceMs ? Date.now() - sinceMs : undefined;

  const { data, isLoading, isFetching } = useQuery<{
    entries: AppLogEntry[];
    total: number;
    sources: string[];
  }>({
    queryKey: ["admin", "logs", levelFilter, sourceFilter, timeRange, search, page, rowsPerPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(rowsPerPage),
        offset: String(offset),
      });
      if (levelFilter && levelFilter !== "all") params.set("level", levelFilter);
      if (sourceFilter && sourceFilter !== "all") params.set("source", sourceFilter);
      if (since) params.set("since", String(since));
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`${env.apiUrl}/api/admin/logs?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load logs");
      return res.json();
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });

  useEffect(() => {
    if (autoRefresh && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [autoRefresh]);

  const sources = data?.sources ?? [];

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
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>Level</InputLabel>
          <Select
            value={levelFilter}
            label="Level"
            onChange={(e) => {
              setLevelFilter(e.target.value);
              setPage(0);
            }}
          >
            {LEVEL_OPTIONS.map((l) => (
              <MenuItem key={l} value={l}>
                {l === "all" ? "All" : l.toUpperCase()}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Source</InputLabel>
          <Select
            value={sourceFilter}
            label="Source"
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setPage(0);
            }}
          >
            <MenuItem value="all">All sources</MenuItem>
            {sources.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Time range</InputLabel>
          <Select
            value={timeRange}
            label="Time range"
            onChange={(e) => {
              setTimeRange(e.target.value);
              setPage(0);
            }}
          >
            {Object.keys(TIME_RANGES).map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          size="small"
          placeholder="Search…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          sx={{ minWidth: 180 }}
        />

        <Box sx={{ flexGrow: 1 }} />

        <Chip label={`${data?.total ?? 0} entries`} size="small" variant="outlined" />

        <Tooltip title={autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}>
          <IconButton size="small" onClick={() => setAutoRefresh((v) => !v)}>
            {autoRefresh ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
          </IconButton>
        </Tooltip>

        <Tooltip title="Refresh">
          <IconButton
            size="small"
            onClick={() => void qc.invalidateQueries({ queryKey: ["admin", "logs"] })}
            disabled={isFetching}
          >
            {isFetching ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
      <Box
        sx={{
          bgcolor: "grey.900",
          borderRadius: 1,
          border: "1px solid",
          borderColor: "divider",
          maxHeight: 520,
          overflowY: "auto",
          minHeight: 200,
        }}
      >
        {isLoading ? (
          <Stack
            sx={{
              gap: 0.5,
              p: 1,
            }}
          >
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} variant="text" height={20} sx={{ bgcolor: "grey.800" }} />
            ))}
          </Stack>
        ) : !data?.entries.length ? (
          <Box
            sx={{
              py: 6,
              textAlign: "center",
            }}
          >
            <Typography
              variant="body2"
              sx={{
                color: "grey.600",
                fontFamily: "monospace",
              }}
            >
              No log entries match the current filters
            </Typography>
          </Box>
        ) : (
          <>
            {data.entries.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </Box>
      <AdminTablePagination
        {...paginationProps}
        count={data?.total ?? 0}
        rowsPerPageOptions={[100, 200, 500]}
        hideSinglePage={false}
      />
    </Stack>
  );
}
