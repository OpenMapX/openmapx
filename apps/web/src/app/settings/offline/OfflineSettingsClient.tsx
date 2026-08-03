"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, OfflinePackageBbox, OfflinePackageRequest } from "@openmapx/core";
import {
  createPlace,
  geoJsonBBox,
  idsFromPrimaryOrCoords,
  useAutocomplete,
  useDebounce,
  usePlaceDetails,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { haptics } from "@/lib/haptics";
import {
  configureDefaultOfflinePackageResolver,
  createOfflinePackageStorage,
  defaultOfflinePackageApi,
  downloadOfflinePackage,
  notifyOfflinePackageChanged,
  type OfflinePackageDownloadProgress,
  type OfflinePackageRecord,
  validateOfflineStyleAssets,
} from "@/lib/offlineAreas";
import { requestPersistentStorage } from "@/lib/persistentStorage";
import {
  isRecentMapDataCacheEnabled,
  setRecentMapDataCacheEnabled,
} from "@/lib/recentMapDataCache";
import { formatBytes } from "@/lib/storageFormat";
import { useNetworkStatus } from "@/lib/useNetworkStatus";
import { AreaPickerMap } from "./AreaPickerMap";
import { OfflineMapView } from "./OfflineMapView";
import { OfflinePackageStatus } from "./OfflinePackageStatus";

const MIN_ZOOM_LIMIT = 0;
const MAX_ZOOM_LIMIT = 18;
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 14;
const FALLBACK_REGION_HALF_DEG = 0.15;

const storage = createOfflinePackageStorage();
const api = defaultOfflinePackageApi;

async function refreshPackageRecords(
  setRecords: (records: OfflinePackageRecord[]) => void,
): Promise<void> {
  setRecords(await storage.list());
}

async function waitForManifest(
  jobId: string,
  onProgress: (progress: OfflinePackageDownloadProgress) => void,
  signal: AbortSignal,
): Promise<NonNullable<Awaited<ReturnType<typeof api.getManifest>>>> {
  let delay = 500;
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const job = await api.getJob(jobId, signal);
    onProgress({
      packageId: job.packageId ?? job.jobId,
      status: "preparing",
      bytesReceived: 0,
      bytesTotal: 0,
      speedBytesPerSecond: 0,
      ...(job.errorMessage
        ? { error: { code: job.errorCode ?? "preparation-failed", message: job.errorMessage } }
        : {}),
    });
    if (job.status === "ready-to-download" && job.packageId) {
      return job.manifest ?? (await api.getManifest(job.packageId, signal));
    }
    if (job.status === "failed" || job.status === "expired") {
      throw new Error(job.errorMessage ?? "Offline package preparation failed");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, delay);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
    delay = Math.min(5_000, Math.round(delay * 1.5));
  }
}

export function OfflineSettingsClient() {
  const t = useTranslations("settings");
  const env = useEnv();
  const [records, setRecords] = useState<OfflinePackageRecord[]>([]);
  const [capability, setCapability] = useState<Awaited<ReturnType<typeof api.capability>> | null>(
    null,
  );
  const [adding, setAdding] = useState(false);
  const [overview, setOverview] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const aborts = useRef(new Map<string, AbortController>());

  const refresh = useCallback(() => {
    void refreshPackageRecords(setRecords);
  }, []);

  useEffect(() => {
    refresh();
    void api.capability().then((next) => {
      setCapability(next);
      if (next.available && next.datasetVersion && next.styleVersion) {
        configureDefaultOfflinePackageResolver({
          datasetVersion: next.datasetVersion,
          styleVersion: next.styleVersion,
          tileSchema: "openmaptiles",
        });
      }
    });
  }, [refresh]);

  const deletePackage = async (record: OfflinePackageRecord) => {
    await storage.delete(record.id);
    notifyOfflinePackageChanged(record.id);
    await getDefaultResolverRefresh();
    refresh();
  };

  const resume = async (record: OfflinePackageRecord) => {
    if (runningId) return;
    const controller = new AbortController();
    aborts.current.set(record.id, controller);
    setRunningId(record.id);
    try {
      await downloadOfflinePackage(api, storage, record.manifest, {
        name: record.name,
        signal: controller.signal,
        validateStyles: async () => {
          await validateOfflineStyleAssets(record.manifest);
        },
      });
      haptics.success();
    } catch {
      // The record contains the recoverable error and is shown below.
    } finally {
      aborts.current.delete(record.id);
      setRunningId(null);
      await getDefaultResolverRefresh();
      refresh();
    }
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 0.5 }}>
          {t("offline")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("offlineDescription")}
        </Typography>
      </Box>
      {!capability?.available || env.styleProvider !== "openmapx" ? (
        <Alert severity="info">{t("offlineProviderUnavailable")}</Alert>
      ) : null}
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setAdding(true)}
          disabled={!capability?.available || env.styleProvider !== "openmapx"}
        >
          {t("downloadNewArea")}
        </Button>
        {records.length > 0 ? (
          <Button
            variant="outlined"
            startIcon={<MapOutlinedIcon />}
            onClick={() => setOverview(true)}
          >
            {t("overview")}
          </Button>
        ) : null}
      </Stack>
      <RecentDataOfflineToggle />
      <PackageList
        records={records}
        runningId={runningId}
        onResume={resume}
        onDelete={deletePackage}
      />
      {adding ? (
        <DownloadAreaDialog
          open={adding}
          capability={capability}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}
      {overview ? (
        <Dialog open={overview} onClose={() => setOverview(false)} maxWidth="md" fullWidth>
          <DialogTitle>{t("overviewTitle")}</DialogTitle>
          <DialogContent>
            <OfflineMapView
              packages={records.filter((record) => record.status === "ready")}
              height={460}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOverview(false)}>{t("close")}</Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </Stack>
  );
}

async function getDefaultResolverRefresh(): Promise<void> {
  const resolver = (await import("@/lib/offlineAreas")).getDefaultOfflinePackageResolver();
  await resolver?.refresh();
}

function RecentDataOfflineToggle() {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEnabled(isRecentMapDataCacheEnabled()), []);
  const handleChange = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    try {
      await setRecentMapDataCacheEnabled(next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            disabled={busy}
            onChange={(event) => void handleChange(event.target.checked)}
          />
        }
        label={
          <Stack spacing={0.5}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t("rememberRecentMapData")}
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("rememberRecentMapDataDescription")}
            </Typography>
          </Stack>
        }
        sx={{ alignItems: "flex-start", m: 0 }}
      />
    </Paper>
  );
}

function PackageList({
  records,
  runningId,
  onResume,
  onDelete,
}: {
  records: OfflinePackageRecord[];
  runningId: string | null;
  onResume: (record: OfflinePackageRecord) => void;
  onDelete: (record: OfflinePackageRecord) => void;
}) {
  const t = useTranslations("settings");
  const [removing, setRemoving] = useState<OfflinePackageRecord | null>(null);
  const [viewing, setViewing] = useState<OfflinePackageRecord | null>(null);
  if (records.length === 0)
    return (
      <Paper variant="outlined" sx={{ p: 3, textAlign: "center", borderRadius: 2 }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("noAreas")}
        </Typography>
      </Paper>
    );
  return (
    <>
      <Paper variant="outlined" sx={{ borderRadius: 2 }}>
        <List disablePadding>
          {records.map((record, index) => (
            <ListItem
              key={record.id}
              divider={index < records.length - 1}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  aria-label={t("remove")}
                  onClick={() => setRemoving(record)}
                  size="small"
                >
                  <DeleteOutlineIcon />
                </IconButton>
              }
            >
              <ListItemButton onClick={() => setViewing(record)}>
                <ListItemText
                  primary={record.name}
                  secondary={
                    <Stack spacing={0.25}>
                      <Typography
                        variant="caption"
                        component="span"
                        sx={{ color: "text.secondary" }}
                      >
                        {formatBytes(record.manifest.archive.byteLength)} · z
                        {record.manifest.coverage.minZoom}–{record.manifest.coverage.maxZoom}
                      </Typography>
                      <OfflinePackageStatus
                        record={record}
                        onResume={() => onResume(record)}
                        disabled={runningId !== null}
                      />
                    </Stack>
                  }
                  slotProps={{ secondary: { component: "div" } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Paper>
      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} maxWidth="md" fullWidth>
        <DialogTitle>{viewing?.name}</DialogTitle>
        <DialogContent>
          {viewing ? (
            <Stack spacing={1.5}>
              <OfflineMapView
                packages={viewing.status === "ready" ? [viewing] : []}
                fitTo={viewing.manifest.coverage.bbox}
                height={420}
              />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {formatBytes(viewing.manifest.archive.byteLength)} · z
                {viewing.manifest.coverage.minZoom}–{viewing.manifest.coverage.maxZoom}
              </Typography>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>{t("close")}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)}>
        <DialogTitle>{t("removeArea")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("removeAreaDescription", {
              name: removing?.name ?? "",
              size: formatBytes(removing?.manifest.archive.byteLength ?? 0),
            })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{t("cancel")}</Button>
          <Button
            color="error"
            onClick={async () => {
              if (!removing) return;
              await onDelete(removing);
              setRemoving(null);
            }}
          >
            {t("remove")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

interface DownloadAreaDialogProps {
  open: boolean;
  capability: Awaited<ReturnType<typeof api.capability>> | null;
  onClose: () => void;
  onSaved: () => void;
}

function DownloadAreaDialog({ open, capability, onClose, onSaved }: DownloadAreaDialogProps) {
  const t = useTranslations("settings");
  const [name, setName] = useState("");
  const [bbox, setBbox] = useState<OfflinePackageBbox | null>(null);
  const [zoomRange, setZoomRange] = useState<[number, number]>([
    DEFAULT_MIN_ZOOM,
    DEFAULT_MAX_ZOOM,
  ]);
  const [progress, setProgress] = useState<OfflinePackageDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const locale = useLocale();
  const network = useNetworkStatus();
  const [meteredConfirmed, setMeteredConfirmed] = useState(false);
  const [recentDataOptIn, setRecentDataOptIn] = useState(false);
  const [recentDataOptInVisible, setRecentDataOptInVisible] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [selectedRegion, setSelectedRegion] = useState<AutocompleteResult | null>(null);
  const debouncedSearch = useDebounce(searchInput, 250);
  const { data: autocompleteData, isFetching: searching } = useAutocomplete(
    debouncedSearch,
    locale,
  );
  const regionOptions = useMemo(
    () => (autocompleteData ?? []).filter((result) => result.type === "region"),
    [autocompleteData],
  );
  const regionPlace = useMemo(
    () =>
      selectedRegion?.coordinates
        ? createPlace({
            ...idsFromPrimaryOrCoords(selectedRegion.id, selectedRegion.coordinates),
            name: selectedRegion.label,
            address: selectedRegion.sublabel ?? selectedRegion.label,
            coordinates: selectedRegion.coordinates,
            category: "region",
          })
        : null,
    [selectedRegion],
  );
  const placeDetailsId =
    regionPlace && regionPlace.primaryScheme !== "coordinate" ? regionPlace.id : null;
  const { data: regionDetails } = usePlaceDetails(
    placeDetailsId,
    regionPlace?.coordinates,
    regionPlace?.name,
    locale,
    Boolean(regionPlace?.address),
  );
  const regionBoundary = regionDetails?.boundary ?? null;
  const fitBbox = useMemo<OfflinePackageBbox | null>(() => {
    if (regionDetails?.boundingBox) {
      const [west, south, east, north] = regionDetails.boundingBox;
      return { west, south, east, north };
    }
    if (regionBoundary) {
      const box = geoJsonBBox(regionBoundary);
      if (box) {
        const [west, south, east, north] = box;
        return { west, south, east, north };
      }
    }
    if (selectedRegion?.coordinates) {
      const [longitude, latitude] = selectedRegion.coordinates;
      return {
        west: longitude - FALLBACK_REGION_HALF_DEG,
        south: latitude - FALLBACK_REGION_HALF_DEG,
        east: longitude + FALLBACK_REGION_HALF_DEG,
        north: latitude + FALLBACK_REGION_HALF_DEG,
      };
    }
    return null;
  }, [regionDetails, regionBoundary, selectedRegion]);
  const maxZoomLimit = Math.min(MAX_ZOOM_LIMIT, capability?.sourceMaxZoom ?? MAX_ZOOM_LIMIT);

  useEffect(() => {
    const enabled = !isRecentMapDataCacheEnabled();
    setRecentDataOptInVisible(enabled);
    setRecentDataOptIn(enabled);
    setZoomRange((current) => [
      Math.min(current[0], maxZoomLimit),
      Math.min(current[1], maxZoomLimit),
    ]);
  }, [maxZoomLimit]);

  const start = async () => {
    if (!bbox || !capability?.available || busy) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await requestPersistentStorage();
      if (recentDataOptInVisible && recentDataOptIn) await setRecentMapDataCacheEnabled(true);
      const request: OfflinePackageRequest = {
        bbox,
        minZoom: zoomRange[0],
        maxZoom: zoomRange[1],
        provider: "openmapx",
      };
      const prepared = await api.prepare(request, controller.signal);
      const manifest =
        prepared.status === "ready-to-download" && prepared.manifest
          ? prepared.manifest
          : await waitForManifest(prepared.jobId, setProgress, controller.signal);
      const result = await downloadOfflinePackage(api, storage, manifest, {
        name: name.trim() || t("offlineDefaultName"),
        signal: controller.signal,
        onProgress: setProgress,
        validateStyles: async () => {
          await validateOfflineStyleAssets(manifest);
        },
      });
      if (result.status !== "ready") throw new Error(t("offlinePackageNotReady"));
      haptics.success();
      onSaved();
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError"))
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) abortRef.current?.abort();
    else onClose();
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth>
      <DialogTitle>{t("downloadNewArea")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {progress?.status === "preparing" ? (
            <Alert severity="info">{t("offlinePreparing")}</Alert>
          ) : null}
          {progress?.status === "verifying" ? (
            <Alert severity="info">{t("offlineVerifying")}</Alert>
          ) : null}
          <TextField
            label={t("areaName")}
            placeholder={t("areaNamePlaceholder")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            fullWidth
          />
          <Autocomplete
            options={regionOptions}
            loading={searching}
            value={selectedRegion}
            onChange={(_event, option) => {
              setSelectedRegion(option);
              if (option) {
                setSearchInput(option.label);
                if (!name.trim()) setName(option.label.split(",")[0]?.trim() ?? "");
              }
            }}
            inputValue={searchInput}
            onInputChange={(_event, value) => setSearchInput(value)}
            getOptionLabel={(option) => option.label}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t("searchArea")}
                placeholder={t("searchAreaPlaceholder")}
                helperText={t("searchAreaDescription")}
              />
            )}
          />
          <AreaPickerMap
            initialCenter={[10.45, 51.16]}
            initialZoom={4}
            onChange={(nextBbox) => setBbox(nextBbox)}
            fitBbox={fitBbox}
            boundary={regionBoundary}
          />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("moveToSelect")}
          </Typography>
          <Typography variant="body2">
            {t("minZoom")}: {zoomRange[0]} · {t("maxZoom")}: {zoomRange[1]}
            {capability?.sourceMaxZoom !== undefined
              ? ` (${t("sourceMaxZoom")}: ${capability.sourceMaxZoom})`
              : ""}
          </Typography>
          <Slider
            value={zoomRange}
            min={MIN_ZOOM_LIMIT}
            max={maxZoomLimit}
            step={1}
            onChange={(_event, value) => {
              if (Array.isArray(value)) setZoomRange([value[0], value[1]]);
            }}
            valueLabelDisplay="auto"
            disableSwap
          />
          {progress && progress.bytesTotal > 0 ? (
            <OfflinePackageStatus progress={progress} />
          ) : null}
          {!network.online ? <Alert severity="warning">{t("offlineNetworkRequired")}</Alert> : null}
          {recentDataOptInVisible ? (
            <FormControlLabel
              control={
                <Switch
                  checked={recentDataOptIn}
                  onChange={(event) => setRecentDataOptIn(event.target.checked)}
                />
              }
              label={t("rememberRecentMapData")}
            />
          ) : null}
          {!meteredConfirmed && network.metered ? (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={() => setMeteredConfirmed(true)}>
                  {t("meteredConfirm")}
                </Button>
              }
            >
              {t("meteredWarning", {
                size: progress?.bytesTotal
                  ? formatBytes(progress.bytesTotal)
                  : t("offlineMeasuredAfterPreparation"),
              })}
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{busy ? t("pause") : t("cancel")}</Button>
        <Button
          variant="contained"
          onClick={() => void start()}
          disabled={
            busy ||
            !bbox ||
            !capability?.available ||
            !network.online ||
            (network.metered && !meteredConfirmed)
          }
        >
          {busy ? t("downloading") : t("startDownload")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
