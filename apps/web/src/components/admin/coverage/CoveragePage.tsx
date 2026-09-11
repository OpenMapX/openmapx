"use client";

import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { CoverageDomain, CoverageSourceRow, UsageAssessment } from "@openmapx/core/coverage";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CoverageRequestError,
  useCoverageRegions,
  useCoverageReport,
} from "@/lib/admin/coverageHooks";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { CompactAlert } from "../shared/CompactAlert";
import { CoverageSourcesTable } from "./CoverageSourcesTable";
import { CoverageStatus, formatCoverageDate } from "./CoverageStatus";
import { RegionCapabilities } from "./RegionCapabilities";
import { RegionCoverageMatrix } from "./RegionCoverageMatrix";
import { SourceEvidenceDrawer } from "./SourceEvidenceDrawer";

const DOMAINS: readonly CoverageDomain[] = [
  "addresses",
  "pois",
  "transit",
  "ev",
  "parking",
  "traffic",
];
const ASSESSMENTS: readonly UsageAssessment[] = [
  "operational",
  "commercial",
  "redistribute-source-data",
  "redistribute-derived-data",
];

function numberParam(value: string | null, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function CoveragePage() {
  const t = useTranslations("adminCoverage");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [announcement, setAnnouncement] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const handledExpiry = useRef<unknown>(null);

  const regionParam = searchParams.get("regionId") ?? "";
  const snapshotId = searchParams.get("snapshotId") ?? undefined;
  const domainParam = searchParams.get("domain") as CoverageDomain | null;
  const domain = domainParam && DOMAINS.includes(domainParam) ? domainParam : undefined;
  const attention = searchParams.get("attention") === "true";
  const enabledParam = searchParams.get("enabled");
  const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;
  const assessmentParam = searchParams.get("assessment") as UsageAssessment | null;
  const assessment =
    assessmentParam && ASSESSMENTS.includes(assessmentParam) ? assessmentParam : "operational";
  const offset = snapshotId ? numberParam(searchParams.get("offset"), 0) : 0;
  const limit = Math.min(numberParam(searchParams.get("limit"), 50) || 50, 100);
  const sourceKey = searchParams.get("source") ?? "";

  const regionOffset = snapshotId ? numberParam(searchParams.get("regionOffset"), 0) : 0;
  const regionsQuery = useCoverageRegions({
    snapshotId,
    refreshNonce,
    offset: regionOffset,
    limit: 100,
  });
  const selectedRegionId = regionParam;
  const reportQuery = useCoverageReport(
    selectedRegionId
      ? {
          regionId: selectedRegionId,
          snapshotId,
          refreshNonce,
          domain,
          attention,
          enabled,
          assessment,
          offset,
          limit,
        }
      : null,
  );

  const selectedSource = useMemo<CoverageSourceRow | null>(() => {
    if (!sourceKey || !reportQuery.data) return null;
    return reportQuery.data.sources.find((source) => source.key === sourceKey) ?? null;
  }, [reportQuery.data, sourceKey]);

  const updateParams = useCallback(
    (changes: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const serialized = next.toString();
      router.replace(serialized ? `${pathname}?${serialized}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const changeFilter = (changes: Record<string, string | null | undefined>) => {
    setRefreshNonce((value) => value + 1);
    updateParams({ ...changes, snapshotId: null, source: null, offset: "0" });
  };

  const resetRevision = useCallback(() => {
    setRefreshNonce((value) => value + 1);
    updateParams({ snapshotId: null, source: null, offset: "0", regionOffset: "0" });
  }, [updateParams]);

  useEffect(() => {
    if (!regionParam && regionsQuery.data?.regions[0]) {
      const preferred =
        regionsQuery.data.regions.find((row) => row.region.kind !== "unassigned") ??
        regionsQuery.data.regions[0];
      updateParams({ regionId: preferred.region.key, offset: "0" });
    }
  }, [regionParam, regionsQuery.data, updateParams]);

  useEffect(() => {
    if (
      reportQuery.data &&
      !reportQuery.isFetching &&
      !reportQuery.isError &&
      reportQuery.data.snapshotId !== snapshotId
    ) {
      updateParams({ snapshotId: reportQuery.data.snapshotId });
    }
  }, [reportQuery.data, reportQuery.isFetching, reportQuery.isError, snapshotId, updateParams]);

  useEffect(() => {
    const error = (reportQuery.error ?? regionsQuery.error) as CoverageRequestError | null;
    if (error?.status === 409 && handledExpiry.current !== error) {
      handledExpiry.current = error;
      resetRevision();
      setAnnouncement(t("snapshot.expired"));
    }
  }, [reportQuery.error, regionsQuery.error, resetRevision, t]);

  useEffect(() => {
    const deadline = reportQuery.data?.nextDeadlineAt;
    if (!deadline) return;
    const timestamp = Date.parse(deadline);
    if (!Number.isFinite(timestamp)) return;
    const delay = Math.min(2_147_483_647, Math.max(1000, timestamp - Date.now()));
    const timer = window.setTimeout(() => {
      setAnnouncement(t("refresh.deadline"));
      resetRevision();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [reportQuery.data?.nextDeadlineAt, resetRevision, t]);

  const refresh = () => {
    setAnnouncement(t("refresh.started"));
    resetRevision();
  };
  const isFetching = regionsQuery.isFetching || reportQuery.isFetching;
  const report = reportQuery.data;
  const collectionStatus = report?.collectionStatus ?? regionsQuery.data?.collectionStatus;
  const warningReasons = [
    ...new Set([...(regionsQuery.data?.warnings ?? []), ...(report?.warnings ?? [])]),
  ];

  return (
    <Box>
      <AdminPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Tooltip title={t("refresh.label")}>
            <span>
              <IconButton
                size="small"
                onClick={refresh}
                disabled={isFetching}
                aria-label={t("refresh.label")}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        }
      />

      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {announcement}
      </Box>

      <Stack spacing={2} sx={{ mt: 2 }}>
        <Paper
          component="section"
          variant="outlined"
          sx={{ p: 1.5 }}
          aria-label={t("filters.title")}
        >
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            sx={{ alignItems: { md: "center" }, flexWrap: "wrap" }}
          >
            <FormControl
              size="small"
              sx={{ minWidth: 210, flex: 1 }}
              disabled={regionsQuery.isLoading || regionsQuery.data?.regions.length === 0}
            >
              <InputLabel id="coverage-region-label">{t("filters.region")}</InputLabel>
              <Select
                labelId="coverage-region-label"
                label={t("filters.region")}
                value={selectedRegionId}
                onChange={(event) => changeFilter({ regionId: event.target.value })}
              >
                {selectedRegionId &&
                  !regionsQuery.data?.regions.some(
                    (row) => row.region.key === selectedRegionId,
                  ) && (
                    <MenuItem value={selectedRegionId}>
                      {reportQuery.data?.region.label ?? selectedRegionId}
                    </MenuItem>
                  )}
                {regionsQuery.data?.regions.map((row) => (
                  <MenuItem key={row.region.key} value={row.region.key}>
                    {row.region.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="coverage-domain-label">{t("filters.domain")}</InputLabel>
              <Select
                labelId="coverage-domain-label"
                label={t("filters.domain")}
                value={domain ?? "all"}
                onChange={(event) =>
                  changeFilter({ domain: event.target.value === "all" ? null : event.target.value })
                }
              >
                <MenuItem value="all">{t("filters.allDomains")}</MenuItem>
                {DOMAINS.map((item) => (
                  <MenuItem key={item} value={item}>
                    {t(`domain.${item}`)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="coverage-assessment-label">{t("filters.assessment")}</InputLabel>
              <Select
                labelId="coverage-assessment-label"
                label={t("filters.assessment")}
                value={assessment}
                onChange={(event) => changeFilter({ assessment: event.target.value })}
              >
                {ASSESSMENTS.map((item) => (
                  <MenuItem key={item} value={item}>
                    {t(`assessment.${item}`)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 155 }}>
              <InputLabel id="coverage-enabled-label">{t("filters.enabled")}</InputLabel>
              <Select
                labelId="coverage-enabled-label"
                label={t("filters.enabled")}
                value={enabled === undefined ? "all" : enabled ? "true" : "false"}
                onChange={(event) =>
                  changeFilter({
                    enabled: event.target.value === "all" ? null : event.target.value,
                  })
                }
              >
                <MenuItem value="all">{t("filters.allSources")}</MenuItem>
                <MenuItem value="true">{t("filters.enabledOnly")}</MenuItem>
                <MenuItem value="false">{t("filters.disabledOnly")}</MenuItem>
              </Select>
            </FormControl>
            <FormControlLabel
              control={
                <Switch
                  checked={attention}
                  onChange={(event) =>
                    changeFilter({ attention: event.target.checked ? "true" : null })
                  }
                />
              }
              label={t("filters.attention")}
            />
          </Stack>
        </Paper>

        {collectionStatus && (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            sx={{ alignItems: { sm: "center" } }}
          >
            <Typography variant="body2" color="text.secondary">
              {t("collection.status")}
            </Typography>
            <CoverageStatus
              status={
                collectionStatus === "complete"
                  ? "operational"
                  : collectionStatus === "partial"
                    ? "limited"
                    : "unavailable"
              }
              label={t(`collection.${collectionStatus}`)}
            />
            {report && (
              <Typography variant="caption" color="text.secondary">
                {t("collection.collectedAt", { date: formatCoverageDate(report.generatedAt) })}
              </Typography>
            )}
          </Stack>
        )}

        <Stack component="section" aria-label={t("collection.authorities")} spacing={0.25}>
          {(report?.authorities ?? regionsQuery.data?.authorities ?? []).map((authority) => (
            <Typography key={authority.authority} variant="caption" color="text.secondary">
              {authority.authority}: {t(`collection.${authority.status}`)}
              {authority.message ? ` · ${authority.message}` : ""}
            </Typography>
          ))}
        </Stack>

        {warningReasons.length > 0 && (
          <CompactAlert severity="warning">
            {warningReasons.map((reason) => t(`reason.${reason}`)).join(" · ")}
          </CompactAlert>
        )}

        {regionsQuery.isLoading && !regionsQuery.data && (
          <Stack sx={{ alignItems: "center", py: 6 }}>
            <CircularProgress aria-label={t("common.loading")} />
          </Stack>
        )}
        {regionsQuery.isError && <Alert severity="error">{t("errors.regions")}</Alert>}
        {regionsQuery.data && regionsQuery.data.regions.length === 0 && (
          <Alert severity="info">{t("matrix.empty")}</Alert>
        )}
        {regionsQuery.data && regionsQuery.data.regions.length > 0 && (
          <RegionCoverageMatrix
            data={regionsQuery.data}
            selectedRegionId={selectedRegionId}
            onPageChange={(nextOffset) =>
              updateParams({
                regionOffset: String(nextOffset),
                snapshotId: report?.snapshotId ?? regionsQuery.data?.snapshotId,
              })
            }
            onSelect={(regionId, selectedDomain) =>
              changeFilter({ regionId, domain: selectedDomain ?? domain ?? null })
            }
          />
        )}

        {selectedRegionId && reportQuery.isLoading && !report && (
          <Stack sx={{ alignItems: "center", py: 5 }}>
            <CircularProgress aria-label={t("common.loading")} />
          </Stack>
        )}
        {reportQuery.isError && <Alert severity="error">{t("errors.report")}</Alert>}
        {report && (
          <>
            <RegionCapabilities report={report} domain={domain} />
            <CoverageSourcesTable
              report={report}
              onSelect={(source) => updateParams({ source: source.key })}
              onPageChange={(nextOffset) =>
                updateParams({ offset: String(nextOffset), source: null })
              }
              onRowsPerPageChange={(nextLimit) =>
                updateParams({ limit: String(nextLimit), offset: "0", source: null })
              }
            />
          </>
        )}
      </Stack>

      <SourceEvidenceDrawer
        source={selectedSource}
        sourceKey={sourceKey || undefined}
        regionId={selectedRegionId}
        snapshotId={report?.snapshotId ?? snapshotId}
        assessment={assessment}
        onClose={() => updateParams({ source: null })}
        onSnapshotExpired={() => {
          resetRevision();
          setAnnouncement(t("snapshot.expired"));
        }}
      />
    </Box>
  );
}
