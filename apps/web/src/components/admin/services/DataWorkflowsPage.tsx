"use client";

import BuildIcon from "@mui/icons-material/Build";
import RefreshIcon from "@mui/icons-material/Refresh";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
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
import * as sdk from "@openmapx/core/api-admin-sdk";
import type {
  AdminServiceData,
  AdminServiceSharedMobilityCategory,
} from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  invalidateServiceAdministration,
  serviceAdminQueries,
  serviceOrThrow,
} from "@/lib/admin/serviceAdmin";
import { formatBytes } from "@/lib/storageFormat";
import { useActivityClient } from "../activity/activityQueries";
import { AdminOperationCard } from "../operations/AdminOperationCard";
import type { AdminOperationContract } from "../operations/adminOperationsApi";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { useAdminToast } from "../shared/AdminToast";
import { AmbientPlacesMaintenance } from "./AmbientPlacesMaintenance";
import { ArtifactTransfersSection } from "./ArtifactTransfersSection";
import { DataInventorySection } from "./DataInventorySection";
import { NotablePlacesMaintenance, notablePlacesStatusQueryKey } from "./NotablePlacesMaintenance";
import { OvertureMaintenance, overtureStatusQueryKey } from "./OvertureMaintenance";
import { SearchIndexMaintenance, searchIndexStatusQueryKey } from "./SearchIndexMaintenance";
import { TransitSourcesSection } from "./TransitSourcesSection";

type MotisTransitousStatus = AdminServiceData["motisTransitous"];

/** Overture and search operations have their own maintenance sections below. */
const DATA_OPERATION_GROUPS: ReadonlySet<AdminOperationContract["group"]> = new Set([
  "osm",
  "build",
  "transit",
]);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DataOperationsSection({ apiUrl }: { apiUrl: string }) {
  const showToast = useAdminToast();
  const { client } = useActivityClient();
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const catalog = useQuery({
    ...serviceAdminQueries(client, apiUrl).operations(),
    staleTime: 5 * 60_000,
  });

  const handleQueued = (jobId: string, operation: AdminOperationContract) => {
    setLastJobId(jobId);
    showToast(`Queued ${operation.title} (${jobId})`);
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
        {(catalog.data?.operations ?? [])
          .filter((operation) => DATA_OPERATION_GROUPS.has(operation.group))
          .map((operation) => (
            <Grid key={operation.id} size={{ xs: 12, md: 6 }}>
              <AdminOperationCard
                apiUrl={apiUrl}
                operation={operation}
                refreshKeys={[
                  overtureStatusQueryKey(apiUrl),
                  searchIndexStatusQueryKey(apiUrl),
                  notablePlacesStatusQueryKey(apiUrl),
                ]}
                onQueued={handleQueued}
                onError={(message) => showToast(message, "error")}
              />
            </Grid>
          ))}
      </Grid>
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
  const { client } = useActivityClient();
  const policy = useQuery({
    ...serviceAdminQueries(client, apiUrl).policy(),
    refetchInterval: 30_000,
  });
  const data = policy.data;
  const rollback = useMutation({
    retry: false,
    mutationFn: async ({
      category,
      enabled,
    }: {
      category: AdminServiceSharedMobilityCategory;
      enabled: boolean;
    }) => {
      const effect = { kind: "policy" } as const;
      const result = await serviceOrThrow(
        sdk.rollbackAdminSharedMobility(category, { enabled }, { client }),
      );
      // This response is the completed policy change, not a job acknowledgement.
      await invalidateServiceAdministration(queryClient, apiUrl, effect);
      return result;
    },
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
      {policy.isError && <Alert severity="error">Failed to load shared mobility policy.</Alert>}
      {rollback.isError && <Alert severity="error">{rollback.error.message}</Alert>}
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
  const { apiUrl } = useActivityClient();
  return <DataWorkflowsView key={apiUrl} />;
}
function DataWorkflowsView() {
  const { apiUrl, client } = useActivityClient();
  const [osmOffset, setOsmOffset] = useState(0);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    ...serviceAdminQueries(client, apiUrl).data({ osmLimit: 50, osmOffset }),
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
        <DataInventorySection osm={data.osm} builds={data.builds} onPageChange={setOsmOffset} />
        <ArtifactTransfersSection apiUrl={apiUrl} />
        <OvertureMaintenance apiUrl={apiUrl} />
        <SearchIndexMaintenance apiUrl={apiUrl} />
        <AmbientPlacesMaintenance apiUrl={apiUrl} />
        <NotablePlacesMaintenance apiUrl={apiUrl} />
        <TransitSourcesSection apiUrl={apiUrl} />
        <MotisTransitousSection status={data.motisTransitous} />
        <SharedMobilityPolicySection apiUrl={apiUrl} />
      </Stack>
    </Box>
  );
}
