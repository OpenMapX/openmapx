"use client";

import BuildIcon from "@mui/icons-material/Build";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { formatBytes } from "@/lib/storageFormat";
import { AdminOperationCard } from "../operations/AdminOperationCard";
import {
  type AdminOperationContract,
  fetchAdminOperations,
} from "../operations/adminOperationsApi";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { useAdminToast } from "../shared/AdminToast";
import { OvertureMaintenance } from "./OvertureMaintenance";
import { SearchIndexMaintenance } from "./SearchIndexMaintenance";
import { TransitSourcesSection } from "./TransitSourcesSection";

interface OsmInfo {
  found: boolean;
  filename?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  region?: string;
}

interface BuildStatus {
  target: string;
  built: boolean;
  builtAt?: string;
}

interface MotisTransitousStatus {
  configFound: boolean;
  datasetCount: number;
  realtimeFeedCount: number;
  gbfsFeedCount: number;
  feedProxyUrlCount: number;
  gbfsProxyUrl: string | null;
  feedProxyMode: "none" | "self-hosted" | "transitous-cloud" | "mixed";
  feedProxyConfigFound: boolean;
  feedProxyVarsFound: boolean;
  feedProxyFeedCount: number;
  capabilityState: "healthy" | "stale" | "missing" | "error";
  capabilityError?: string;
  activeEpoch: string | null;
  candidateEpoch: string | null;
  testedAt: string | null;
  configHash: string | null;
  licenseHash: string | null;
  rentalProviderCount: number;
  rentalProviderGroupCount: number;
  rollbackAvailable: boolean;
  operationsProfile: "regional-assisted" | "regional-sovereign" | "planet" | "unknown";
  activeSlot: "A" | "B" | null;
  previousHealthySlot: "A" | "B" | null;
  preflightState: "passed" | "blocked" | "missing";
  preflightRequiredDiskBytes: number | null;
  preflightFreeDiskBytes: number | null;
  pinProposalPending: boolean;
  crowdsourceState: "disabled-pending-review";
  gbfsCatalog: {
    state: "active" | "missing" | "error";
    commit: string | null;
    lockedAt: string | null;
    registryRows: number;
    registryAdded: number;
    transitousPreferred: number;
    quarantined: number;
    validationFailed: number;
    sources: Array<{
      sourceId: string;
      country: string;
      status: "configured" | "excluded";
      observation: "validated" | "unknown";
      errorClass?: string;
      lastObservedSuccess?: string;
      lastErrorAt?: string;
      dataAge: "unknown";
    }>;
  };
}

interface DataResponse {
  osm: OsmInfo;
  builds: BuildStatus[];
  motisTransitous: MotisTransitousStatus;
  fetchedAt: string;
}

/** Overture and search operations have their own maintenance sections below. */
const DATA_OPERATION_GROUPS: ReadonlySet<AdminOperationContract["group"]> = new Set([
  "osm",
  "build",
  "transit",
]);

interface SharedMobilityOperationsState {
  rollbackCategories: Array<"bike" | "scooter" | "car">;
  decisions: Array<{
    category: "bike" | "scooter" | "car";
    recordedAt: string;
    decision: {
      policy: "fanout" | "shadow" | "motis-first";
      local: "healthy" | "partial" | "error";
      calledAdapters: string[];
      skippedAdapters: string[];
      partial: boolean;
    };
  }>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BUILD_LABELS: Record<string, string> = {
  valhalla: "Valhalla",
  osrm: "OSRM",
  otp: "OpenTripPlanner",
  motis: "MOTIS",
  motisFeedProxy: "MOTIS Feed Proxy",
  tiles: "Tile Server",
  pelias: "Pelias",
  nominatim: "Nominatim",
  photon: "Photon",
  overpass: "Overpass",
};

function DataOperationsSection({ apiUrl }: { apiUrl: string }) {
  const showToast = useAdminToast();
  const queryClient = useQueryClient();
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const catalog = useQuery<AdminOperationContract[]>({
    queryKey: ["admin", "operations"],
    queryFn: () => fetchAdminOperations(apiUrl),
    staleTime: 5 * 60_000,
  });

  const handleQueued = (jobId: string, operation: AdminOperationContract) => {
    setLastJobId(jobId);
    showToast(`Queued ${operation.title} (${jobId})`);
    queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    queryClient.invalidateQueries({ queryKey: ["admin-services-data"] });
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <BuildIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          Data Operations
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button component={Link} href="/admin/activity" variant="outlined" size="small">
          Open Activity
        </Button>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        Queue data jobs from the GUI. Each operation previews its effect before it is queued and
        streams its progress to Activity.
      </Typography>
      {lastJobId && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button component={Link} href="/admin/activity" size="small" color="inherit">
              View Jobs
            </Button>
          }
        >
          Last queued job: <code>{lastJobId}</code>
        </Alert>
      )}
      {catalog.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {catalog.error instanceof Error ? catalog.error.message : "Failed to load operations"}
        </Alert>
      )}
      {catalog.isLoading && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}
      <Grid container spacing={2}>
        {(catalog.data ?? [])
          .filter((operation) => DATA_OPERATION_GROUPS.has(operation.group))
          .map((operation) => (
            <Grid key={operation.id} size={{ xs: 12, md: 6 }}>
              <AdminOperationCard
                apiUrl={apiUrl}
                operation={operation}
                onQueued={handleQueued}
                onError={(message) => showToast(message, "error")}
              />
            </Grid>
          ))}
      </Grid>
    </Paper>
  );
}

function OsmSection({ osm }: { osm: OsmInfo }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <StorageIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          OSM Planet Data
        </Typography>
      </Stack>
      {osm.found ? (
        <Stack spacing={1}>
          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
            <Box>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                File
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: "monospace",
                }}
              >
                {osm.filename}
              </Typography>
            </Box>
            {osm.region && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Region
                </Typography>
                <Typography variant="body2">{osm.region}</Typography>
              </Box>
            )}
            {osm.sizeBytes && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Size
                </Typography>
                <Typography variant="body2">{formatBytes(osm.sizeBytes)}</Typography>
              </Box>
            )}
            {osm.modifiedAt && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Downloaded
                </Typography>
                <Typography variant="body2">{formatDate(osm.modifiedAt)}</Typography>
              </Box>
            )}
          </Stack>
          <Chip
            icon={<CheckCircleIcon />}
            label="OSM PBF present"
            color="success"
            size="small"
            sx={{ width: "fit-content" }}
          />
        </Stack>
      ) : (
        <Alert severity="warning" sx={{ mb: 1 }}>
          No OSM PBF file found in the data directory. Queue an OSM download above.
        </Alert>
      )}
    </Paper>
  );
}

function BuildsSection({ builds }: { builds: BuildStatus[] }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <BuildIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          Service Build Inventory
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          Read-only view of which services have populated their data dirs
        </Typography>
      </Stack>
      <Grid container spacing={2}>
        {builds.map((b) => (
          <Grid key={b.target} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card variant="outlined">
              <CardContent sx={{ pb: "12px !important" }}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    alignItems: "center",
                    mb: 1,
                  }}
                >
                  {b.built ? (
                    <CheckCircleIcon fontSize="small" sx={{ color: "success.main" }} />
                  ) : (
                    <HelpOutlineIcon fontSize="small" sx={{ color: "text.disabled" }} />
                  )}
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {BUILD_LABELS[b.target] ?? b.target}
                  </Typography>
                </Stack>
                {b.builtAt && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      display: "block",
                    }}
                  >
                    Built {formatDate(b.builtAt)}
                  </Typography>
                )}
                {!b.built && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      display: "block",
                    }}
                  >
                    Not built
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
      <Alert severity="info" sx={{ mt: 2 }}>
        Each service builds its own indexes/graphs on first start. Trigger rebuilds from the service
        catalog or queue data update/build operations.
      </Alert>
    </Paper>
  );
}

function motisProxyModeColor(
  mode: MotisTransitousStatus["feedProxyMode"],
): "default" | "success" | "warning" | "error" {
  if (mode === "self-hosted") return "success";
  if (mode === "none") return "default";
  if (mode === "mixed") return "warning";
  return "error";
}

function MotisTransitousSection({ status }: { status: MotisTransitousStatus }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <StorageIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          MOTIS Transitous Parity
        </Typography>
      </Stack>
      {!status.configFound ? (
        <Alert severity="warning">
          No MOTIS config found yet. Sync transit sources and build MOTIS data.
        </Alert>
      ) : (
        <Stack spacing={1.5}>
          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
            <Chip label={`${status.datasetCount} schedule dataset(s)`} size="small" />
            <Chip label={`${status.realtimeFeedCount} realtime feed(s)`} size="small" />
            <Chip label={`${status.gbfsFeedCount} GBFS feed(s)`} size="small" />
            <Chip label={`${status.feedProxyUrlCount} proxied URL(s)`} size="small" />
            <Chip
              label={`Feed proxy: ${status.feedProxyMode}`}
              color={motisProxyModeColor(status.feedProxyMode)}
              size="small"
            />
            <Chip
              label={`Capabilities: ${status.capabilityState}`}
              color={status.capabilityState === "healthy" ? "success" : "error"}
              size="small"
            />
            <Chip label={`${status.rentalProviderCount} rental provider(s)`} size="small" />
            <Chip
              label={`Profile: ${status.operationsProfile}`}
              color={status.operationsProfile === "planet" ? "warning" : "default"}
              size="small"
            />
            <Chip
              label={`Slot: ${status.activeSlot ?? "legacy"}`}
              color={status.activeSlot ? "success" : "default"}
              size="small"
            />
            <Chip
              label={`Preflight: ${status.preflightState}`}
              color={status.preflightState === "passed" ? "success" : "warning"}
              size="small"
            />
            <Chip
              label={`Pinned GBFS: ${status.gbfsCatalog.state}`}
              color={status.gbfsCatalog.state === "active" ? "success" : "default"}
              size="small"
            />
          </Stack>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            Proxy artifacts: config {status.feedProxyConfigFound ? "present" : "missing"} · vars{" "}
            {status.feedProxyVarsFound ? "present" : "missing"} · {status.feedProxyFeedCount} mapped
            feed endpoint(s) · GBFS proxy {status.gbfsProxyUrl ?? "not configured"}
          </Typography>
          {status.gbfsCatalog.state === "active" && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Registry {status.gbfsCatalog.commit?.slice(0, 12)} ·{" "}
              {status.gbfsCatalog.registryAdded} added · {status.gbfsCatalog.transitousPreferred}{" "}
              Transitous-preferred duplicate(s) · {status.gbfsCatalog.quarantined} quarantined ·{" "}
              {status.gbfsCatalog.validationFailed} validation failure(s)
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Active epoch {status.activeEpoch ?? "unknown"} · candidate{" "}
            {status.candidateEpoch ?? "none"} · tested{" "}
            {status.testedAt ? formatDate(status.testedAt) : "never"} · rollback{" "}
            {status.rollbackAvailable ? "available" : "unavailable"}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Capacity:{" "}
            {status.preflightRequiredDiskBytes != null
              ? `${formatBytes(status.preflightRequiredDiskBytes)} required`
              : "not estimated"}{" "}
            ·{" "}
            {status.preflightFreeDiskBytes != null
              ? `${formatBytes(status.preflightFreeDiskBytes)} free`
              : "free disk unknown"}{" "}
            · previous healthy slot {status.previousHealthySlot ?? "none"}
            {status.pinProposalPending ? " · pin proposal awaiting review" : ""}
          </Typography>
          <Alert severity="info">
            Crowdsource sidecars are disabled pending authoritative provenance, protocol, license,
            privacy-controller, moderation, and deletion approval.
          </Alert>
          {status.capabilityState !== "healthy" && (
            <Alert severity="error">
              Promoted MOTIS capability evidence is {status.capabilityState}.
              {status.capabilityError
                ? ` ${status.capabilityError}`
                : " Re-run the transactional import before trusting configured counts."}
            </Alert>
          )}
          {(status.feedProxyMode === "transitous-cloud" || status.feedProxyMode === "mixed") && (
            <Alert severity={status.feedProxyMode === "mixed" ? "warning" : "error"}>
              MOTIS config still references Transitous cloud feed-proxy URLs. Rebuild MOTIS data to
              switch fully to self-hosted proxy URLs.
            </Alert>
          )}
        </Stack>
      )}
    </Paper>
  );
}

function SharedMobilityPolicySection({ apiUrl }: { apiUrl: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery<SharedMobilityOperationsState>({
    queryKey: ["admin-shared-mobility-policy"],
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/admin/shared-mobility`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load shared mobility policy");
      return response.json();
    },
    refetchInterval: 30_000,
  });
  const rollback = useMutation({
    mutationFn: async ({ category, enabled }: { category: string; enabled: boolean }) => {
      const response = await fetch(
        `${apiUrl}/api/admin/shared-mobility/${encodeURIComponent(category)}/rollback`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!response.ok) throw new Error("Failed to update shared mobility rollback");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-shared-mobility-policy"] }),
  });

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        Shared mobility source policy
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        MOTIS-first decisions contain category-level operational state only; no coordinates or
        vehicle IDs are recorded. Enable rollback to restore fan-out immediately.
      </Typography>
      <Stack spacing={1.5}>
        {(["bike", "scooter", "car"] as const).map((category) => {
          const record = data?.decisions.find((decision) => decision.category === category);
          const enabled = data?.rollbackCategories.includes(category) ?? false;
          return (
            <Stack
              key={category}
              direction={{ xs: "column", sm: "row" }}
              spacing={1}
              sx={{ alignItems: { sm: "center" } }}
            >
              <Typography sx={{ minWidth: 80, textTransform: "capitalize" }}>{category}</Typography>
              <Chip
                size="small"
                label={record ? `${record.decision.policy} · ${record.decision.local}` : "no data"}
                color={record?.decision.partial ? "warning" : "success"}
              />
              {record && (
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  called {record.decision.calledAdapters.join(", ") || "MOTIS only"}; skipped{" "}
                  {record.decision.skippedAdapters.join(", ") || "none"}
                </Typography>
              )}
              <FormControlLabel
                control={
                  <Switch
                    checked={enabled}
                    disabled={rollback.isPending}
                    onChange={(_, checked) => rollback.mutate({ category, enabled: checked })}
                  />
                }
                label="Fan-out rollback"
              />
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}

export function DataWorkflowsPage() {
  const { apiUrl } = useEnv();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DataResponse>({
    queryKey: ["admin-services-data"],
    queryFn: () =>
      fetch(`${apiUrl}/api/admin/services/data`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 6,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !data) {
    return <Alert severity="error">Failed to load data inventory.</Alert>;
  }

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <AdminPageHeader
          title="Data workflows"
          subtitle="Manage OSM data, transit sources, builds, and long-running data jobs"
          actions={
            <>
              <Tooltip title="Refresh">
                <IconButton size="small" onClick={() => refetch()} disabled={isFetching}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Button component={Link} href="/admin/services" variant="outlined" size="small">
                ← Services
              </Button>
            </>
          }
        />
      </Box>
      <Stack spacing={2}>
        <DataOperationsSection apiUrl={apiUrl} />
        <OsmSection osm={data.osm} />
        <OvertureMaintenance apiUrl={apiUrl} />
        <SearchIndexMaintenance apiUrl={apiUrl} />
        <TransitSourcesSection apiUrl={apiUrl} />
        <MotisTransitousSection status={data.motisTransitous} />
        <SharedMobilityPolicySection apiUrl={apiUrl} />
        <BuildsSection builds={data.builds} />
      </Stack>
    </Box>
  );
}
