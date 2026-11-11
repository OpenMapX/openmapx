"use client";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminServiceData } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import { formatBytes } from "@/lib/storageFormat";
import { useActivityClient } from "../activity/activityQueries";

type MotisTransitousStatus = AdminServiceData["motisTransitous"];
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
function motisProxyModeColor(
  mode: MotisTransitousStatus["feedProxyMode"],
): "default" | "success" | "warning" | "error" {
  if (mode === "self-hosted") return "success";
  if (mode === "none") return "default";
  if (mode === "mixed") return "warning";
  return "error";
}

export function MotisTransitousSection({ status }: { status: MotisTransitousStatus }) {
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

export function SharedMobilitySourcesSection({ apiUrl }: { apiUrl: string }) {
  const { client } = useActivityClient();
  const sources = useQuery({
    ...serviceAdminQueries(client, apiUrl).sharedMobility(),
    refetchInterval: 30_000,
  });
  const data = sources.data;

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        Shared mobility sources
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every request queries MOTIS and all direct sources. Decisions contain category-level
        operational state only; no coordinates or vehicle IDs are recorded.
      </Typography>
      {sources.isError && <Alert severity="error">Failed to load shared mobility sources.</Alert>}
      <Stack spacing={1.5}>
        {(["bike", "scooter", "car"] as const).map((category) => {
          const record = data?.decisions.find((decision) => decision.category === category);
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
                label={record ? `MOTIS ${record.decision.local}` : "no data"}
                color={record ? (record.decision.partial ? "warning" : "success") : "default"}
              />
              {record && (
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  queried {record.decision.calledAdapters.join(", ") || "MOTIS only"}
                </Typography>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}
