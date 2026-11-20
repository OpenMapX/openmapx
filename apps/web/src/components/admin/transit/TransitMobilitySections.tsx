"use client";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminServiceData } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("adminTransit");
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
          {t("motisTransitousParity")}
        </Typography>
      </Stack>
      {!status.configFound ? (
        <Alert severity="warning">{t("noMotisConfigFoundYet")}</Alert>
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
            <Chip
              label={t("datasetcountScheduleDatasetS", { datasetCount: status.datasetCount })}
              size="small"
            />
            <Chip
              label={t("realtimefeedcountRealtimeFeedS", {
                realtimeFeedCount: status.realtimeFeedCount,
              })}
              size="small"
            />
            <Chip
              label={t("gbfsfeedcountGbfsFeedS", { gbfsFeedCount: status.gbfsFeedCount })}
              size="small"
            />
            <Chip
              label={t("feedproxyurlcountProxiedUrlS", {
                feedProxyUrlCount: status.feedProxyUrlCount,
              })}
              size="small"
            />
            <Chip
              label={t("feedProxyFeedproxymode", { feedProxyMode: status.feedProxyMode })}
              color={motisProxyModeColor(status.feedProxyMode)}
              size="small"
            />
            <Chip
              label={t("capabilitiesCapabilitystate", { capabilityState: status.capabilityState })}
              color={status.capabilityState === "healthy" ? "success" : "error"}
              size="small"
            />
            <Chip
              label={t("rentalprovidercountRentalProviderS", {
                rentalProviderCount: status.rentalProviderCount,
              })}
              size="small"
            />
            <Chip
              label={t("profileOperationsprofile", { operationsProfile: status.operationsProfile })}
              color={status.operationsProfile === "planet" ? "warning" : "default"}
              size="small"
            />
            <Chip
              label={t("slotValue", { value: status.activeSlot ?? "legacy" })}
              color={status.activeSlot ? "success" : "default"}
              size="small"
            />
            <Chip
              label={t("preflightPreflightstate", { preflightState: status.preflightState })}
              color={status.preflightState === "passed" ? "success" : "warning"}
              size="small"
            />
            <Chip
              label={t("pinnedGbfsState", { state: status.gbfsCatalog.state })}
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
            {t("proxyArtifactsConfig")}
            {status.feedProxyConfigFound ? "present" : "missing"} {t("vars")}
            {status.feedProxyVarsFound ? "present" : "missing"}{" "}
            {t("feedproxyfeedcountMappedFeedEndpointS", {
              feedProxyFeedCount: status.feedProxyFeedCount,
            })}
            {status.gbfsProxyUrl ?? t("notConfigured")}
          </Typography>
          {status.gbfsCatalog.state === "active" && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("registryCommitRegistryaddedAddedTransitouspreferred", {
                commit: status.gbfsCatalog.commit?.slice(0, 12) ?? "",
                registryAdded: status.gbfsCatalog.registryAdded,
                transitousPreferred: status.gbfsCatalog.transitousPreferred,
                quarantined: status.gbfsCatalog.quarantined,
                validationFailed: status.gbfsCatalog.validationFailed,
              })}
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("activeEpoch")}
            {status.activeEpoch ?? "unknown"} {t("candidate")}
            {status.candidateEpoch ?? "none"} {t("tested")}
            {status.testedAt ? formatDate(status.testedAt) : "never"} {t("rollback")}
            {status.rollbackAvailable ? "available" : "unavailable"}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("capacity")}
            {status.preflightRequiredDiskBytes != null
              ? t("preflightrequireddiskbytesRequired", {
                  preflightRequiredDiskBytes: formatBytes(status.preflightRequiredDiskBytes),
                })
              : t("notEstimated")}{" "}
            ·{" "}
            {status.preflightFreeDiskBytes != null
              ? t("preflightfreediskbytesFree", {
                  preflightFreeDiskBytes: formatBytes(status.preflightFreeDiskBytes),
                })
              : t("freeDiskUnknown")}
            {t("previousHealthySlot")}
            {status.previousHealthySlot ?? "none"}
            {status.pinProposalPending ? t("pinProposalAwaitingReview") : ""}
          </Typography>
          <Alert severity="info">{t("crowdsourceSidecarsAreDisabledPending")}</Alert>
          {status.capabilityState !== "healthy" && (
            <Alert severity="error">
              {t("promotedMotisCapabilityEvidenceIs", { capabilityState: status.capabilityState })}
              {status.capabilityError
                ? t("capabilityerror", { capabilityError: status.capabilityError })
                : t("reRunTheTransactionalImport")}
            </Alert>
          )}
          {(status.feedProxyMode === "transitous-cloud" || status.feedProxyMode === "mixed") && (
            <Alert severity={status.feedProxyMode === "mixed" ? "warning" : "error"}>
              {t("motisConfigStillReferencesTransitous")}
            </Alert>
          )}
        </Stack>
      )}
    </Paper>
  );
}

export function SharedMobilitySourcesSection({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminTransit");
  const { client } = useActivityClient();
  const sources = useQuery({
    ...serviceAdminQueries(client, apiUrl).sharedMobility(),
    refetchInterval: 30_000,
  });
  const data = sources.data;

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        {t("sharedMobilitySources")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("everyRequestQueriesMotisAnd")}
      </Typography>
      {sources.isError && <Alert severity="error">{t("failedToLoadSharedMobility")}</Alert>}
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
                label={record ? t("motisLocal", { local: record.decision.local }) : t("noData")}
                color={record ? (record.decision.partial ? "warning" : "success") : "default"}
              />
              {record && (
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  {t("queried")}
                  {record.decision.calledAdapters.join(", ") || t("motisOnly")}
                </Typography>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}
