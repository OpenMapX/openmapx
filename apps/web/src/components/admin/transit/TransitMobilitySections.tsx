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
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import { useActivityClient } from "../activity/activityQueries";

type MotisTransitousStatus = AdminServiceData["motisTransitous"];
/** ICU select keys cannot hold hyphens, so `self-hosted` is selected as `self_hosted`. */
function selectKey(value: string): string {
  return value.replaceAll("-", "_");
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
  const format = useAdminFormat();
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
            <Chip label={t("scheduleDatasets", { count: status.datasetCount })} size="small" />
            <Chip label={t("realtimeFeeds", { count: status.realtimeFeedCount })} size="small" />
            <Chip label={t("gbfsFeeds", { count: status.gbfsFeedCount })} size="small" />
            <Chip label={t("proxiedUrls", { count: status.feedProxyUrlCount })} size="small" />
            <Chip
              label={t("feedProxyMode", { mode: selectKey(status.feedProxyMode) })}
              color={motisProxyModeColor(status.feedProxyMode)}
              size="small"
            />
            <Chip
              label={t("capabilityState", { state: status.capabilityState })}
              color={status.capabilityState === "healthy" ? "success" : "error"}
              size="small"
            />
            <Chip
              label={t("rentalProviders", { count: status.rentalProviderCount })}
              size="small"
            />
            <Chip
              label={t("operationsProfile", { profile: selectKey(status.operationsProfile) })}
              color={status.operationsProfile === "planet" ? "warning" : "default"}
              size="small"
            />
            <Chip
              label={
                status.activeSlot ? t("activeSlot", { slot: status.activeSlot }) : t("legacySlot")
              }
              color={status.activeSlot ? "success" : "default"}
              size="small"
            />
            <Chip
              label={t("preflightState", { state: status.preflightState })}
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
            {t("proxyArtifacts", {
              config: String(status.feedProxyConfigFound),
              vars: String(status.feedProxyVarsFound),
              count: status.feedProxyFeedCount,
              gbfsProxy: status.gbfsProxyUrl ?? t("notConfigured"),
            })}
          </Typography>
          {status.gbfsCatalog.state === "active" && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("gbfsRegistry", {
                commit: status.gbfsCatalog.commit?.slice(0, 12) ?? "",
                added: status.gbfsCatalog.registryAdded,
                transitousPreferred: status.gbfsCatalog.transitousPreferred,
                quarantined: status.gbfsCatalog.quarantined,
                validationFailed: status.gbfsCatalog.validationFailed,
              })}
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("epochs", {
              active: status.activeEpoch ?? t("unknownValue"),
              candidate: status.candidateEpoch ?? t("noneValue"),
              tested: status.testedAt ? format.dateTime(status.testedAt) : t("neverTested"),
              rollback: String(status.rollbackAvailable),
            })}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("capacity", {
              required:
                status.preflightRequiredDiskBytes != null
                  ? t("diskRequired", { bytes: format.bytes(status.preflightRequiredDiskBytes) })
                  : t("notEstimated"),
              free:
                status.preflightFreeDiskBytes != null
                  ? t("diskFree", { bytes: format.bytes(status.preflightFreeDiskBytes) })
                  : t("freeDiskUnknown"),
              previousSlot: status.previousHealthySlot ?? t("noneValue"),
            })}
            {status.pinProposalPending ? ` · ${t("pinProposalAwaitingReview")}` : ""}
          </Typography>
          <Alert severity="info">{t("crowdsourceSidecarsAreDisabledPending")}</Alert>
          {status.capabilityState !== "healthy" && (
            <Alert severity="error">
              {status.capabilityError
                ? t("capabilityEvidenceError", {
                    state: status.capabilityState,
                    error: status.capabilityError,
                  })
                : t("capabilityEvidenceRerun", { state: status.capabilityState })}
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
              <Typography sx={{ minWidth: 80 }}>{t("mobilityCategory", { category })}</Typography>
              <Chip
                size="small"
                label={record ? t("motisLocal", { local: record.decision.local }) : t("noData")}
                color={record ? (record.decision.partial ? "warning" : "success") : "default"}
              />
              {record && (
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  {record.decision.calledAdapters.length
                    ? t("queriedAdapters", { adapters: record.decision.calledAdapters.join(", ") })
                    : t("queriedMotisOnly")}
                </Typography>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}
