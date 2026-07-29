"use client";

import ArticleIcon from "@mui/icons-material/Article";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import type { ServiceDetail as ServiceDetailData } from "@/hooks/useServices";
import {
  useServiceAction,
  useServiceConfig,
  useServiceConfigSave,
  useServiceDetail,
} from "@/hooks/useServices";
import { StatusBadge } from "../integrations/StatusBadge";
import { useAdminToast } from "../shared/AdminToast";
import { CompactAlert } from "../shared/CompactAlert";
import { MetaRow } from "../shared/MetaRow";
import { statusColor, statusLabel } from "../shared/ServiceStatusChip";
import { ServiceConfigForm } from "./ServiceConfigForm";
import { ServiceCredentials } from "./ServiceCredentials";
import { ServiceLogsDrawer } from "./ServiceLogsDrawer";

function OverviewTab({ data }: { data: ServiceDetailData }) {
  const { manifest } = data;

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      <Card variant="outlined">
        <CardContent>
          <Typography
            variant="subtitle2"
            gutterBottom
            sx={{
              color: "text.secondary",
            }}
          >
            Manifest
          </Typography>
          <Stack
            sx={{
              gap: 1,
            }}
          >
            <MetaRow
              label="ID"
              value={
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                  }}
                >
                  {manifest.id}
                </Typography>
              }
            />
            <MetaRow label="Version" value={manifest.version} />
            <MetaRow label="Author" value={manifest.author} />
            <MetaRow label="License" value={manifest.license} />
            <MetaRow label="Platform" value={manifest.platform} />
            {manifest.homepage && (
              <Stack
                direction="row"
                sx={{
                  gap: 1,
                  alignItems: "center",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    minWidth: 130,
                    flexShrink: 0,
                  }}
                >
                  Homepage
                </Typography>
                <Chip
                  label={manifest.homepage}
                  component="a"
                  href={manifest.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  variant="outlined"
                  icon={<OpenInNewIcon sx={{ fontSize: "0.85rem !important" }} />}
                  clickable
                  sx={{ fontSize: "0.7rem", maxWidth: 300 }}
                />
              </Stack>
            )}
            <MetaRow
              label="Directory"
              value={
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                  }}
                >
                  {data.directory}
                </Typography>
              }
            />
          </Stack>
        </CardContent>
      </Card>
      {manifest.description && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Description
            </Typography>
            <Typography variant="body2">{manifest.description}</Typography>
          </CardContent>
        </Card>
      )}
      {manifest.provides && manifest.provides.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Provides
            </Typography>
            <Stack
              direction="row"
              sx={{
                gap: 0.5,
                flexWrap: "wrap",
              }}
            >
              {manifest.provides.map((p) => (
                <Chip
                  key={p}
                  label={p}
                  size="small"
                  variant="outlined"
                  sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}
                />
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
      {manifest.consumes && manifest.consumes.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Consumes
            </Typography>
            <Stack
              sx={{
                gap: 0.75,
              }}
            >
              {manifest.consumes.map((c) => (
                <Stack
                  key={`${c.type}::${c.mountAt}`}
                  direction="row"
                  sx={{
                    gap: 1,
                    alignItems: "center",
                  }}
                >
                  <Chip
                    label={c.type}
                    size="small"
                    variant="outlined"
                    sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}
                  />
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    mounted at <code style={{ fontFamily: "monospace" }}>{c.mountAt}</code>
                    {c.targetFilename ? ` · as ${c.targetFilename}` : ""}
                    {c.readOnly ? " · read-only" : ""}
                    {c.required === false ? " · optional" : ""}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
      {manifest.envVars && manifest.envVars.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Environment Variables
            </Typography>
            <Stack
              sx={{
                gap: 0.75,
              }}
            >
              {manifest.envVars.map((v) => (
                <Stack
                  key={v.name}
                  direction="row"
                  sx={{
                    gap: 1,
                    alignItems: "flex-start",
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: "monospace",
                      fontWeight: 500,
                      minWidth: 200,
                      flexShrink: 0,
                    }}
                  >
                    {v.name}
                  </Typography>
                  <Stack
                    sx={{
                      gap: 0.25,
                    }}
                  >
                    {v.description && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {v.description}
                      </Typography>
                    )}
                    {v.default !== undefined && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.disabled",
                        }}
                      >
                        default: <code style={{ fontFamily: "monospace" }}>{v.default}</code>
                      </Typography>
                    )}
                  </Stack>
                  <Chip
                    label={v.required ? "required" : "optional"}
                    size="small"
                    color={v.required ? "default" : "info"}
                    variant="outlined"
                    sx={{ fontSize: "0.65rem", flexShrink: 0 }}
                  />
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
      {manifest.exposure && (
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="subtitle2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
              Exposure
            </Typography>
            <Stack
              sx={{
                gap: 1,
              }}
            >
              {manifest.exposure.hostPorts && manifest.exposure.hostPorts.length > 0 && (
                <Stack
                  sx={{
                    gap: 0.5,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Host Ports
                  </Typography>
                  {manifest.exposure.hostPorts.map((p) => (
                    <Typography
                      key={`${p.host}:${p.container}`}
                      variant="body2"
                      sx={{
                        fontFamily: "monospace",
                      }}
                    >
                      {p.host}:{p.container}/{p.protocol ?? "tcp"}
                    </Typography>
                  ))}
                </Stack>
              )}
              {manifest.exposure.proxy?.enabled && (
                <Stack
                  sx={{
                    gap: 0.5,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Reverse Proxy
                  </Typography>
                  {manifest.exposure.proxy.pathPrefix && (
                    <Typography
                      variant="body2"
                      sx={{
                        fontFamily: "monospace",
                      }}
                    >
                      Path: {manifest.exposure.proxy.pathPrefix}
                    </Typography>
                  )}
                </Stack>
              )}
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function ConfigTab({ data }: { data: ServiceDetailData }) {
  const { manifest } = data;
  // Persisted config from `service_config` table (separate query from the
  // manifest itself so the config tab doesn't refetch the full LoadedService).
  const configQuery = useServiceConfig(manifest.id);
  const saveConfig = useServiceConfigSave(manifest.id);
  const action = useServiceAction(manifest.id);

  if (!manifest.configSchema) {
    return (
      <CompactAlert severity="info" variant="outlined">
        No configSchema declared for this service. Configuration is managed via environment
        variables or bind-mounted config files.
      </CompactAlert>
    );
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography
          variant="subtitle2"
          gutterBottom
          sx={{
            color: "text.secondary",
          }}
        >
          Configuration
        </Typography>
        <ServiceConfigForm
          serviceId={manifest.id}
          schema={manifest.configSchema}
          resolvedConfig={configQuery.data?.resolvedConfig ?? {}}
          envPrefix={configQuery.data?.envPrefix}
          onSave={async (values) => {
            await saveConfig.mutateAsync(values);
          }}
          onSaveAndApply={async (values) => {
            // Service configs land in the generated compose env, so applying
            // a new value must go through `docker compose up -d` semantics.
            // Persist first so a failed apply doesn't lose the edit.
            await saveConfig.mutateAsync(values);
            await action.mutateAsync("start");
          }}
        />
      </CardContent>
    </Card>
  );
}

function ManifestTab({ data }: { data: ServiceDetailData }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography
          variant="subtitle2"
          gutterBottom
          sx={{
            color: "text.secondary",
          }}
        >
          Raw Manifest (service.json)
        </Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            bgcolor: "action.hover",
            borderRadius: 1,
            fontFamily: "monospace",
            fontSize: "0.78rem",
            lineHeight: 1.6,
            overflow: "auto",
            maxHeight: 600,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {JSON.stringify(data.manifest, null, 2)}
        </Box>
      </CardContent>
    </Card>
  );
}

const TABS = ["Overview", "Configuration", "Credentials", "Logs", "Manifest"];

interface ServiceDetailProps {
  id: string;
}

export function ServiceDetail({ id }: ServiceDetailProps) {
  const [tab, setTab] = useState(0);
  const [logsOpen, setLogsOpen] = useState(false);
  const showToast = useAdminToast();

  const { data, isLoading, isError } = useServiceDetail(id);
  const actionMutation = useServiceAction(id);

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 8,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !data) {
    return (
      <CompactAlert severity="error" variant="outlined">
        Failed to load service details. The backend may not be running yet.
      </CompactAlert>
    );
  }

  const { manifest } = data;
  const isBusy = actionMutation.isPending;

  async function runAction(action: "start" | "stop" | "restart") {
    try {
      const result = await actionMutation.mutateAsync(action);
      if (result.ok) {
        // The backend enqueues the action via the job runner and returns immediately.
        // Container state will transition asynchronously; the status chip refreshes
        // via the invalidated ["admin", "services"] query.
        showToast(`Service ${action} queued${result.jobId ? ` (job ${result.jobId})` : ""}`);
      } else {
        showToast(`Action "${action}" was rejected`, "warning");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Action "${action}" failed`, "error");
    }
  }

  function handleTabChange(_: React.SyntheticEvent, value: number) {
    setTab(value);
    // Auto-open the logs drawer when the Logs tab is selected.
    if (TABS[value] === "Logs") {
      setLogsOpen(true);
    }
  }

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      <Stack sx={{ gap: 1 }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 1.5,
          }}
        >
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 1.5,
              flexWrap: "wrap",
              minWidth: 0,
              flexGrow: 1,
            }}
          >
            <Typography
              variant="h5"
              sx={{
                fontWeight: 700,
              }}
            >
              {manifest.name}
            </Typography>
            <StatusBadge quality={manifest.quality} />
            <Tooltip title={`Container status: ${statusLabel(data.status)}`}>
              <Chip
                label={statusLabel(data.status)}
                size="small"
                color={statusColor(data.status)}
                variant={data.status === "running" ? "filled" : "outlined"}
                sx={{ fontSize: "0.7rem" }}
              />
            </Tooltip>
            {!data.enabled && (
              <Chip
                label="Disabled"
                size="small"
                color="default"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
            )}
          </Stack>
          <Stack
            direction="row"
            sx={{
              gap: 1,
              flexWrap: "wrap",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <Tooltip title="Apply the latest rendered configuration and hardlink plan to this service.">
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="success"
                  startIcon={isBusy ? <CircularProgress size={14} /> : <PlayArrowIcon />}
                  onClick={() => runAction("start")}
                  disabled={isBusy}
                >
                  {data.status === "running" ? "Apply changes" : "Start"}
                </Button>
              </span>
            </Tooltip>
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={isBusy ? <CircularProgress size={14} /> : <StopIcon />}
              onClick={() => runAction("stop")}
              disabled={isBusy || data.status === "exited" || data.status === "not-running"}
            >
              Stop
            </Button>
            <Tooltip title="In-place restart only. Use Start to apply new config/compose/hardlink changes.">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={isBusy ? <CircularProgress size={14} /> : <RefreshIcon />}
                  onClick={() => runAction("restart")}
                  disabled={isBusy}
                >
                  Restart
                </Button>
              </span>
            </Tooltip>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ArticleIcon />}
              onClick={() => setLogsOpen(true)}
            >
              Logs
            </Button>
          </Stack>
        </Stack>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            fontFamily: "monospace",
          }}
        >
          {manifest.id} · v{manifest.version}
        </Typography>
        {manifest.description && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {manifest.description}
          </Typography>
        )}
      </Stack>
      <Divider />
      <Box>
        <Tabs
          value={tab}
          onChange={handleTabChange}
          sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}
          variant="scrollable"
          scrollButtons="auto"
        >
          {TABS.map((label) => (
            <Tab key={label} label={label} />
          ))}
        </Tabs>

        {tab === 0 && <OverviewTab data={data} />}
        {tab === 1 && <ConfigTab data={data} />}
        {tab === 2 && <ServiceCredentials serviceId={data.manifest.id} />}
        {tab === 3 && (
          <Box
            sx={{
              py: 2,
            }}
          >
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              Click "Logs" or switch to this tab to open the live log stream.
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<ArticleIcon />}
              onClick={() => setLogsOpen(true)}
              sx={{ mt: 1.5 }}
            >
              Open Logs Drawer
            </Button>
          </Box>
        )}
        {tab === 4 && <ManifestTab data={data} />}
      </Box>
      <ServiceLogsDrawer
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        serviceId={id}
        serviceName={manifest.name}
      />
    </Stack>
  );
}
