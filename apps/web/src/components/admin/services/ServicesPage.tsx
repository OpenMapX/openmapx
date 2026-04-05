"use client";

import LogsIcon from "@mui/icons-material/Article";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import ErrorIcon from "@mui/icons-material/Error";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import StopIcon from "@mui/icons-material/Stop";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonGroup from "@mui/material/ButtonGroup";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

// Types

interface ServiceStatus {
  service: string;
  state: "running" | "stopped" | "unhealthy" | "unknown";
  status: string;
  image: string;
  id: string;
  ports: string;
  runningFor: string;
  health: string;
  profile: string;
  port?: number;
}

interface ProfileSummary {
  profile: string;
  state: "running" | "partial" | "stopped";
  services: string[];
  controllable?: boolean;
}

interface ServicesResponse {
  services: ServiceStatus[];
  summary: { running: number; stopped: number; unhealthy: number; total: number };
}

interface ProfilesResponse {
  profiles: ProfileSummary[];
}

// Status helpers

function stateColor(state: ServiceStatus["state"]): "success" | "error" | "warning" | "default" {
  if (state === "running") return "success";
  if (state === "unhealthy") return "error";
  if (state === "stopped") return "default";
  return "warning";
}

function stateIcon(state: ServiceStatus["state"]) {
  if (state === "running")
    return <CheckCircleIcon fontSize="small" sx={{ color: "success.main" }} />;
  if (state === "unhealthy") return <ErrorIcon fontSize="small" sx={{ color: "error.main" }} />;
  if (state === "stopped") return <StorageIcon fontSize="small" sx={{ color: "text.disabled" }} />;
  return <HelpOutlineIcon fontSize="small" sx={{ color: "warning.main" }} />;
}

function shortImage(image: string): string {
  return image.replace(/^ghcr\.io\/[^/]+\//, "").replace(/:latest$/, "");
}

// LogsDrawer

function LogsDrawer({
  service,
  open,
  onClose,
  apiUrl,
}: {
  service: string | null;
  open: boolean;
  onClose: () => void;
  apiUrl: string;
}) {
  const { data, isFetching, refetch } = useQuery<string>({
    queryKey: ["service-logs", service],
    queryFn: async () => {
      if (!service) return "";
      const res = await fetch(
        `${apiUrl}/api/admin/services/${encodeURIComponent(service)}/logs?lines=200`,
        {
          credentials: "include",
        },
      );
      return res.text();
    },
    enabled: open && !!service,
    refetchInterval: false,
  });

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: { width: { xs: "100vw", sm: 640 }, display: "flex", flexDirection: "column" },
      }}
    >
      <Box
        sx={{
          p: 2,
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        <LogsIcon />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
          Logs — {service}
        </Typography>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => refetch()} disabled={isFetching}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {isFetching && <LinearProgress />}
      <Box
        component="pre"
        sx={{
          flex: 1,
          overflowY: "auto",
          p: 2,
          fontSize: 12,
          fontFamily: "monospace",
          bgcolor: "grey.900",
          color: "grey.100",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          m: 0,
        }}
      >
        {data ?? "Loading..."}
      </Box>
    </Drawer>
  );
}

// ServiceCard

function ServiceCard({
  svc,
  onAction,
  onLogs,
  actionPending,
}: {
  svc: ServiceStatus;
  onAction: (service: string, action: "start" | "stop" | "restart") => void;
  onLogs: (service: string) => void;
  actionPending: boolean;
}) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent sx={{ pb: "12px !important" }}>
        <Stack direction="row" alignItems="flex-start" spacing={1} mb={1}>
          {stateIcon(svc.state)}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap title={svc.service}>
              {svc.service}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap title={svc.image}>
              {shortImage(svc.image)}
            </Typography>
          </Box>
          <Chip
            label={svc.state}
            size="small"
            color={stateColor(svc.state)}
            variant="outlined"
            sx={{ fontSize: 11, height: 20 }}
          />
        </Stack>

        <Stack direction="row" spacing={0.5} mb={1.5} flexWrap="wrap" useFlexGap>
          <Chip
            label={svc.profile}
            size="small"
            variant="filled"
            sx={{ fontSize: 10, height: 18, bgcolor: "primary.50", color: "primary.main" }}
          />
          {svc.port && (
            <Chip
              label={`:${svc.port}`}
              size="small"
              variant="outlined"
              sx={{ fontSize: 10, height: 18 }}
            />
          )}
          {svc.runningFor && (
            <Chip
              label={svc.runningFor}
              size="small"
              variant="outlined"
              sx={{ fontSize: 10, height: 18 }}
            />
          )}
        </Stack>

        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
          <Tooltip title="View logs">
            <span>
              <IconButton size="small" onClick={() => onLogs(svc.service)} disabled={actionPending}>
                <LogsIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <ButtonGroup size="small" disabled={actionPending}>
            <Tooltip title="Start">
              <span>
                <Button
                  onClick={() => onAction(svc.service, "start")}
                  disabled={svc.state === "running"}
                  sx={{ minWidth: 32, px: 0.75 }}
                >
                  <PlayArrowIcon fontSize="small" />
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Stop">
              <span>
                <Button
                  onClick={() => onAction(svc.service, "stop")}
                  disabled={svc.state === "stopped"}
                  sx={{ minWidth: 32, px: 0.75 }}
                >
                  <StopIcon fontSize="small" />
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Restart">
              <span>
                <Button
                  onClick={() => onAction(svc.service, "restart")}
                  sx={{ minWidth: 32, px: 0.75 }}
                >
                  <RestartAltIcon fontSize="small" />
                </Button>
              </span>
            </Tooltip>
          </ButtonGroup>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ProfileBar

function ProfileBar({
  profile,
  state,
  onStart,
  onStop,
  pending,
}: {
  profile: string;
  state: "running" | "partial" | "stopped";
  onStart: () => void;
  onStop: () => void;
  pending: boolean;
}) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
      <Chip
        label={state}
        size="small"
        color={state === "running" ? "success" : state === "partial" ? "warning" : "default"}
        variant="outlined"
        sx={{ width: 72, fontSize: 11 }}
      />
      <Typography variant="body2" sx={{ flex: 1 }}>
        <strong>{profile}</strong> profile
      </Typography>
      <ButtonGroup size="small" disabled={pending}>
        <Button startIcon={<PlayArrowIcon />} onClick={onStart} disabled={state === "running"}>
          Start
        </Button>
        <Button startIcon={<StopIcon />} onClick={onStop} disabled={state === "stopped"}>
          Stop
        </Button>
      </ButtonGroup>
    </Stack>
  );
}

// Main component

const ALL_PROFILES = [
  "all",
  "core",
  "proxy",
  "app",
  "routing",
  "transit",
  "pelias",
  "nominatim",
  "photon",
  "overpass",
  "tiles",
  "martin",
];

export function ServicesPage() {
  const { apiUrl } = useEnv();
  const queryClient = useQueryClient();

  const [profileTab, setProfileTab] = useState<string>("all");
  const [logsService, setLogsService] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [pendingService, setPendingService] = useState<string | null>(null);
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ServicesResponse>({
    queryKey: ["admin-services"],
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/admin/services`, { credentials: "include" });
      if (!r.ok) throw new Error(`Services fetch failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000,
  });

  const { data: profilesData } = useQuery<ProfilesResponse>({
    queryKey: ["admin-services-profiles"],
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/admin/services/profiles`, { credentials: "include" });
      if (!r.ok) throw new Error(`Profiles fetch failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000,
  });

  const actionMutation = useMutation({
    mutationFn: async ({ service, action }: { service: string; action: string }) => {
      const res = await fetch(
        `${apiUrl}/api/admin/services/${encodeURIComponent(service)}/${action}`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) throw new Error(`Failed to ${action} ${service}`);
      return res.json();
    },
    onError: (err) => setErrorMsg(err instanceof Error ? err.message : "Service action failed"),
    onSettled: () => {
      setPendingService(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-services"] });
    },
  });

  const profileMutation = useMutation({
    mutationFn: async ({ profile, action }: { profile: string; action: string }) => {
      const res = await fetch(
        `${apiUrl}/api/admin/services/profiles/${encodeURIComponent(profile)}/${action}`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error(`Failed to ${action} profile ${profile}`);
      return res.json();
    },
    onError: (err) => setErrorMsg(err instanceof Error ? err.message : "Profile action failed"),
    onSettled: () => {
      setPendingProfile(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-services"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-services-profiles"] });
    },
  });

  const handleAction = useCallback(
    (service: string, action: "start" | "stop" | "restart") => {
      setPendingService(service);
      actionMutation.mutate({ service, action });
    },
    [actionMutation],
  );

  const handleProfileAction = useCallback(
    (profile: string, action: "start" | "stop") => {
      setPendingProfile(profile);
      profileMutation.mutate({ profile, action });
    },
    [profileMutation],
  );

  const handleLogs = useCallback((service: string) => {
    setLogsService(service);
    setLogsOpen(true);
  }, []);

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" py={6}>
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !data) {
    return <Alert severity="error">Failed to load service status.</Alert>;
  }

  const { services, summary } = data;

  const filtered =
    profileTab === "all" ? services : services.filter((s) => s.profile === profileTab);

  const currentProfile = profilesData?.profiles.find((p) => p.profile === profileTab);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        <Typography variant="h5" fontWeight={700} sx={{ flex: 1 }}>
          Infrastructure Services
        </Typography>
        <Stack direction="row" spacing={1}>
          <Chip label={`${summary.running} running`} color="success" size="small" />
          <Chip label={`${summary.stopped} stopped`} color="default" size="small" />
          {summary.unhealthy > 0 && (
            <Chip label={`${summary.unhealthy} unhealthy`} color="error" size="small" />
          )}
        </Stack>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => refetch()} disabled={isFetching}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Button component={Link} href="/admin/services/data" variant="outlined" size="small">
          Data Workflows
        </Button>
      </Stack>

      {isFetching && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}

      <Tabs
        value={profileTab}
        onChange={(_, v) => setProfileTab(v as string)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        {ALL_PROFILES.map((p) => (
          <Tab
            key={p}
            label={p === "all" ? "All" : p}
            value={p}
            sx={{ textTransform: "none", minWidth: 60 }}
          />
        ))}
      </Tabs>

      {profileTab !== "all" && currentProfile && currentProfile.controllable !== false && (
        <Box sx={{ mb: 2 }}>
          <ProfileBar
            profile={currentProfile.profile}
            state={currentProfile.state}
            onStart={() => handleProfileAction(currentProfile.profile, "start")}
            onStop={() => handleProfileAction(currentProfile.profile, "stop")}
            pending={pendingProfile === currentProfile.profile}
          />
        </Box>
      )}

      {filtered.length === 0 ? (
        <Alert severity="info">No services in this profile.</Alert>
      ) : (
        <Grid container spacing={2}>
          {filtered.map((svc) => (
            <Grid key={svc.service} size={{ xs: 12, sm: 6, md: 4 }}>
              <ServiceCard
                svc={svc}
                onAction={handleAction}
                onLogs={handleLogs}
                actionPending={pendingService === svc.service}
              />
            </Grid>
          ))}
        </Grid>
      )}

      <LogsDrawer
        service={logsService}
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        apiUrl={apiUrl}
      />
      <Snackbar
        open={!!errorMsg}
        autoHideDuration={5000}
        onClose={() => setErrorMsg(null)}
        message={errorMsg}
      />
    </Box>
  );
}
