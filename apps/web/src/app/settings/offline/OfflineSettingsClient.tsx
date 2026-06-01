"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
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
import type { AutocompleteResult } from "@openmapx/core";
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
import { loadOpenMapXStyle, maptilerStyleUrl } from "@/lib/map";
import {
  type AreaDownloadUrls,
  buildAreaDownloadUrls,
  clearAreaResult,
  countTiles,
  type DownloadProgress,
  deleteAreaCache,
  downloadArea,
  listAreas,
  type OfflineArea,
  type OfflineAreaBbox,
  reconcileAreaFromResult,
  removeArea,
  saveArea,
  startBackgroundAreaDownload,
  supportsBackgroundFetch,
  watchBackgroundAreaProgress,
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

const MIN_ZOOM_LIMIT = 0;
const MAX_ZOOM_LIMIT = 18;
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 14;
const TOO_MANY_TILES = 50_000;
// Rough per-asset size used for the size estimate and the background-download
// progress bar (Background Fetch reports bytes, not a fraction).
const BYTES_PER_ASSET_ESTIMATE = 8 * 1024;
// Half-size of the fallback bbox when a searched region has no boundary/extent.
const FALLBACK_REGION_HALF_DEG = 0.15;

export function OfflineSettingsClient() {
  const t = useTranslations("settings");
  const [areas, setAreas] = useState<OfflineArea[]>([]);
  const [adding, setAdding] = useState(false);
  const [overview, setOverview] = useState(false);
  // area id → detach its background-fetch progress listener, so each downloading
  // area is watched exactly once (no duplicate listeners on repeated syncs).
  const watchersRef = useRef<Map<string, () => void>>(new Map());

  // Reconcile + watch background downloads. `markLost` is true only on the
  // initial mount pass: an area still "downloading" then, with neither a
  // completion marker nor a live registration, was interrupted (app killed, SW
  // evicted), so we surface it as failed instead of a permanent spinner. Later
  // passes (a download just started, or an OFFLINE_AREA_DONE message) never mark
  // lost, so they can't kill an in-page download that is actively running.
  const syncOfflineAreas = useCallback(
    async (markLost: boolean) => {
      for (const area of listAreas()) {
        // A completion marker is authoritative regardless of current status.
        const reconciled = await reconcileAreaFromResult(area);
        if (reconciled) {
          const detach = watchersRef.current.get(area.id);
          if (detach) {
            detach();
            watchersRef.current.delete(area.id);
          }
          if (reconciled.status === "ready") haptics.success();
          continue;
        }
        if (area.status !== "downloading" || watchersRef.current.has(area.id)) continue;

        const detach = await watchBackgroundAreaProgress(area.id, (downloaded) => {
          const latest = listAreas().find((a) => a.id === area.id);
          if (!latest || latest.status !== "downloading") return;
          const estTotal = latest.tileCount * BYTES_PER_ASSET_ESTIMATE;
          const frac = estTotal > 0 ? Math.min(1, downloaded / estTotal) : 0;
          saveArea({
            ...latest,
            sizeBytes: downloaded,
            tilesDone: Math.round(latest.tileCount * frac),
          });
          setAreas(listAreas());
        });
        if (detach) {
          watchersRef.current.set(area.id, detach);
        } else if (markLost) {
          saveArea({
            ...area,
            status: "error",
            errorMessage: t("downloadInterrupted"),
            updatedAt: Date.now(),
          });
        }
      }
      setAreas(listAreas());
    },
    [t],
  );

  useEffect(() => {
    setAreas(listAreas());
    // Opening Offline maps acknowledges any "download finished" app badge set
    // by the service worker while the app was backgrounded.
    (navigator as Navigator & { clearAppBadge?: () => Promise<void> })
      .clearAppBadge?.()
      .catch(() => {});
  }, []);

  useEffect(() => {
    void syncOfflineAreas(true);

    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "OFFLINE_AREA_DONE") {
        void syncOfflineAreas(false);
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);

    const watchers = watchersRef.current;
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      for (const detach of watchers.values()) detach();
      watchers.clear();
    };
  }, [syncOfflineAreas]);

  const refresh = useCallback(() => setAreas(listAreas()), []);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 0.5 }}>
          {t("offline")}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("offlineDescription")}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
          {t("downloadNewArea")}
        </Button>
        {areas.length > 0 ? (
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
      <AreaList areas={areas} onChange={refresh} />
      {adding ? (
        <DownloadAreaDialog
          open={adding}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
            // A background download was just queued — attach its progress watcher.
            void syncOfflineAreas(false);
          }}
        />
      ) : null}
      {overview ? (
        <Dialog open={overview} onClose={() => setOverview(false)} maxWidth="md" fullWidth>
          <DialogTitle>{t("overviewTitle")}</DialogTitle>
          <DialogContent>
            <OfflineMapView areas={areas} height={460} />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOverview(false)}>{t("close")}</Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </Stack>
  );
}

/**
 * Discoverable toggle for the recent-map-data offline cache — the same setting
 * buried under Settings → Storage, surfaced here so users setting up offline
 * use can keep the places/routes/searches they open available without a
 * connection. Stored locally only (see the description copy).
 */
function RecentDataOfflineToggle() {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(isRecentMapDataCacheEnabled());
  }, []);

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
            onChange={(e) => void handleChange(e.target.checked)}
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

function AreaList({ areas, onChange }: { areas: OfflineArea[]; onChange: () => void }) {
  const t = useTranslations("settings");
  const [removing, setRemoving] = useState<OfflineArea | null>(null);
  const [viewing, setViewing] = useState<OfflineArea | null>(null);

  if (areas.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3, textAlign: "center", borderRadius: 2 }}>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("noAreas")}
        </Typography>
      </Paper>
    );
  }

  return (
    <>
      <Paper variant="outlined" sx={{ borderRadius: 2 }}>
        <List disablePadding>
          {areas.map((area, idx) => (
            <ListItem
              key={area.id}
              divider={idx < areas.length - 1}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  aria-label={t("remove")}
                  onClick={() => setRemoving(area)}
                  size="small"
                >
                  <DeleteOutlineIcon />
                </IconButton>
              }
            >
              <ListItemButton onClick={() => setViewing(area)}>
                <ListItemText
                  primary={area.name}
                  secondary={<AreaSecondary area={area} />}
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
              <OfflineMapView areas={[viewing]} fitTo={viewing.bbox} height={420} />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {t("tilesProgress", { done: viewing.tilesDone, total: viewing.tileCount })} ·{" "}
                {formatBytes(viewing.sizeBytes)} · z{viewing.minZoom}–{viewing.maxZoom}
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
              size: formatBytes(removing?.sizeBytes ?? 0),
            })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{t("cancel")}</Button>
          <Button
            color="error"
            onClick={async () => {
              if (!removing) return;
              await deleteAreaCache(removing);
              await clearAreaResult(removing.id);
              removeArea(removing.id);
              setRemoving(null);
              onChange();
            }}
          >
            {t("remove")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function AreaSecondary({ area }: { area: OfflineArea }) {
  const t = useTranslations("settings");
  const status =
    area.status === "ready"
      ? t("ready")
      : area.status === "downloading"
        ? t("downloading")
        : area.status === "paused"
          ? t("paused")
          : area.status === "error"
            ? t("errorStatus")
            : "";

  return (
    <Stack spacing={0.5} sx={{ mt: 0.5 }}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        {status} · {t("tilesProgress", { done: area.tilesDone, total: area.tileCount })} ·{" "}
        {formatBytes(area.sizeBytes)}
      </Typography>
      {area.status === "downloading" ? (
        <LinearProgress
          variant="determinate"
          value={area.tileCount > 0 ? (area.tilesDone / area.tileCount) * 100 : 0}
        />
      ) : null}
      {area.status === "error" && area.errorMessage ? (
        <Typography variant="caption" color="error">
          {area.errorMessage}
        </Typography>
      ) : null}
    </Stack>
  );
}

interface DownloadDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function DownloadAreaDialog({ open, onClose, onSaved }: DownloadDialogProps) {
  const t = useTranslations("settings");
  const env = useEnv();
  const [name, setName] = useState("");
  const [bbox, setBbox] = useState<OfflineAreaBbox | null>(null);
  const [currentZoom, setCurrentZoom] = useState(10);
  const [zoomRange, setZoomRange] = useState<[number, number]>([
    DEFAULT_MIN_ZOOM,
    DEFAULT_MAX_ZOOM,
  ]);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Offer to turn on the recent-map-data offline cache as part of the download
  // — only when it's currently off, default-checked since the user is
  // explicitly setting up offline use.
  const [recentDataOptIn, setRecentDataOptIn] = useState(false);
  const [recentDataOptInVisible, setRecentDataOptInVisible] = useState(false);
  useEffect(() => {
    const off = !isRecentMapDataCacheEnabled();
    setRecentDataOptInVisible(off);
    setRecentDataOptIn(off);
  }, []);

  // Warn before downloading a lot of tiles over a metered/cellular connection.
  const network = useNetworkStatus();
  const [meteredConfirmed, setMeteredConfirmed] = useState(false);

  // Admin-boundary search: pick a city/region/country and the area is framed
  // automatically (the user then only tunes the zoom range). Reuses the same
  // autocomplete + place-detail boundary lookup as the main map search.
  const locale = useLocale();
  const [searchInput, setSearchInput] = useState("");
  const [selectedRegion, setSelectedRegion] = useState<AutocompleteResult | null>(null);
  const debouncedSearch = useDebounce(searchInput, 250);
  const { data: autocompleteData, isFetching: searching } = useAutocomplete(
    debouncedSearch,
    locale,
  );
  // Only administrative areas (cities, counties, states, countries) — the ones
  // that carry a boundary we can frame.
  const regionOptions = useMemo(
    () => (autocompleteData ?? []).filter((r) => r.type === "region"),
    [autocompleteData],
  );
  // Build the place the same way the main search does so the server resolves
  // the boundary identically (and React Query dedupes the request).
  const regionPlace = useMemo(() => {
    if (!selectedRegion?.coordinates) return null;
    return createPlace({
      ...idsFromPrimaryOrCoords(selectedRegion.id, selectedRegion.coordinates),
      name: selectedRegion.label,
      address: selectedRegion.sublabel ?? selectedRegion.label,
      coordinates: selectedRegion.coordinates,
      category: "region",
    });
  }, [selectedRegion]);
  // Coordinate-scheme places carry no upstream id to look a boundary up by.
  const placeDetailsId =
    regionPlace && regionPlace.primaryScheme !== "coordinate" ? regionPlace.id : null;
  const { data: regionDetails } = usePlaceDetails(
    placeDetailsId,
    regionPlace?.coordinates,
    regionPlace?.name,
    locale,
    regionPlace ? Boolean(regionPlace.address) : false,
  );
  const regionBoundary = regionDetails?.boundary ?? null;
  // Bbox to frame the picker on: prefer the boundary's reported extent, else
  // derive it from the polygon, else a small box around the point.
  const fitBbox = useMemo<OfflineAreaBbox | null>(() => {
    if (regionDetails?.boundingBox) {
      const [w, s, e, n] = regionDetails.boundingBox;
      return { west: w, south: s, east: e, north: n };
    }
    if (regionBoundary) {
      const box = geoJsonBBox(regionBoundary);
      if (box) {
        const [w, s, e, n] = box;
        return { west: w, south: s, east: e, north: n };
      }
    }
    if (selectedRegion?.coordinates) {
      const [lng, lat] = selectedRegion.coordinates;
      const d = FALLBACK_REGION_HALF_DEG;
      return { west: lng - d, south: lat - d, east: lng + d, north: lat + d };
    }
    return null;
  }, [regionDetails, regionBoundary, selectedRegion]);

  const handleSelectRegion = (option: AutocompleteResult | null) => {
    setSelectedRegion(option);
    if (option) {
      setSearchInput(option.label);
      // Prefill the name with the place name (first segment of the label).
      if (!name.trim()) setName(option.label.split(",")[0]?.trim() ?? "");
    }
  };

  const tileEstimate = useMemo(
    () => (bbox ? countTiles(bbox, zoomRange[0], zoomRange[1]) : 0),
    [bbox, zoomRange],
  );
  const tooLarge = tileEstimate > TOO_MANY_TILES;
  const sizeEstimateBytes = tileEstimate * BYTES_PER_ASSET_ESTIMATE;

  const handleMapChange = useCallback((nextBbox: OfflineAreaBbox, nextZoom: number) => {
    setBbox(nextBbox);
    setCurrentZoom(nextZoom);
  }, []);

  // Default initial center: world view at zoom 4 (user must pan)
  const initialCenter: [number, number] = [10.45, 51.16];

  const startDownload = async () => {
    if (!bbox) return;
    setError(null);
    setProgress(null);
    setDownloading(true);

    // Keep this area safe from eviction before writing anything. Without
    // persistent storage the browser (notably Firefox Android) can reclaim the
    // whole origin between sessions, taking the downloaded tiles — and the
    // offline app itself — with it. Best-effort: never block the download on it.
    await requestPersistentStorage();

    // Opt into keeping recent map data (places/routes/searches) offline if the
    // user left the box checked. Enable early so requests made while using this
    // area get cached.
    if (recentDataOptInVisible && recentDataOptIn) {
      await setRecentMapDataCacheEnabled(true);
    }

    const id = crypto.randomUUID();
    const styleKey = env.styleProvider === "openmapx" ? "openmapx" : "maptiler:multi";

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    let area: OfflineArea = {
      id,
      name: name.trim() || `Area ${new Date().toLocaleString()}`,
      bbox,
      minZoom: zoomRange[0],
      maxZoom: zoomRange[1],
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tileCount: tileEstimate,
      tilesDone: 0,
      sizeBytes: 0,
      styleKey,
    };

    try {
      // Resolve every style variant the user might switch to at runtime.
      // MapCanvas picks bright-v2 in light mode and streets-v2-dark in dark
      // mode; caching both keeps the area usable across theme switches and
      // after the runtime SWR caches expire. The openmapx provider is a
      // single style today.
      const styles =
        env.styleProvider === "openmapx"
          ? [
              {
                url: "/styles/openmapx-streets.json",
                json: (await loadOpenMapXStyle(env)) as Record<string, unknown>,
              },
            ]
          : await Promise.all(
              (["bright-v2", "streets-v2-dark"] as const).map(async (variant) => {
                const url = maptilerStyleUrl(variant, env);
                const json = await (await fetch(url, { signal })).json();
                return { url, json };
              }),
            );

      // Background Fetch needs the full URL list up front; keep it so the
      // in-page fallback below can reuse it instead of resolving styles and
      // re-expanding the tile list a second time.
      let prebuiltUrls: AreaDownloadUrls | undefined;

      // Prefer Background Fetch where available: the OS runs the download so it
      // survives navigation and the screen locking, with a progress
      // notification. The service worker lands the tiles in the same cache.
      if (supportsBackgroundFetch()) {
        prebuiltUrls = await buildAreaDownloadUrls(area, styles, signal);
        const urls = [...prebuiltUrls.styleUrls, ...prebuiltUrls.assetUrls];
        const queued: OfflineArea = {
          ...area,
          status: "downloading",
          tileCount: urls.length,
          tilesDone: 0,
          sizeBytes: 0,
        };
        saveArea(queued);
        const reg = await startBackgroundAreaDownload(queued, urls, { title: queued.name });
        if (reg) {
          onSaved();
          return;
        }
        // Couldn't start (quota/permission) — fall through to the in-page path.
      }

      saveArea(area);
      area = await downloadArea(area, { styles, signal, onProgress: setProgress, prebuiltUrls });
      haptics.success();
      onSaved();
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setDownloading(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{t("downloadNewArea")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label={t("areaName")}
            placeholder={t("areaNamePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
          />

          <Box>
            <Autocomplete
              options={regionOptions}
              filterOptions={(x) => x}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              value={null}
              inputValue={searchInput}
              onInputChange={(_, v, reason) => {
                if (reason === "input" || reason === "clear") setSearchInput(v);
              }}
              onChange={(_, option) => handleSelectRegion(option)}
              loading={searching}
              blurOnSelect
              noOptionsText={
                debouncedSearch.trim().length < 2 ? t("searchAreaHint") : t("noResults")
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={t("searchArea")}
                  placeholder={t("searchAreaPlaceholder")}
                />
              )}
              renderOption={(props, option) => {
                const { key, ...rest } = props;
                return (
                  <Box component="li" key={option.id} {...rest}>
                    <Stack spacing={0} sx={{ py: 0.25 }}>
                      <Typography variant="body2">{option.label}</Typography>
                      {option.sublabel ? (
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          {option.sublabel}
                        </Typography>
                      ) : null}
                    </Stack>
                  </Box>
                );
              }}
            />
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
            >
              {t("searchAreaDescription")}
            </Typography>
          </Box>

          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("moveToSelect")}
          </Typography>

          <AreaPickerMap
            initialCenter={initialCenter}
            initialZoom={5}
            onChange={handleMapChange}
            fitBbox={fitBbox}
            boundary={regionBoundary}
          />

          <Box>
            <Stack
              direction="row"
              sx={{
                justifyContent: "space-between",
              }}
            >
              <Typography variant="body2">{t("minZoom")}</Typography>
              <Typography variant="body2">{t("maxZoom")}</Typography>
            </Stack>
            <Slider
              value={zoomRange}
              onChange={(_, v) =>
                Array.isArray(v) && setZoomRange([v[0], v[1]] as [number, number])
              }
              min={MIN_ZOOM_LIMIT}
              max={MAX_ZOOM_LIMIT}
              valueLabelDisplay="auto"
              marks={[
                { value: 0, label: "0" },
                { value: 5, label: "5" },
                { value: 10, label: "10" },
                { value: 15, label: "15" },
                { value: 18, label: "18" },
              ]}
            />
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("estimatedTiles", { count: tileEstimate.toLocaleString() })} ·{" "}
              {t("estimatedSize", { size: formatBytes(sizeEstimateBytes) })}
              {currentZoom ? ` · z${Math.round(currentZoom)}` : ""}
            </Typography>
          </Box>

          {recentDataOptInVisible ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={recentDataOptIn}
                  onChange={(e) => setRecentDataOptIn(e.target.checked)}
                />
              }
              label={
                <Stack spacing={0.25}>
                  <Typography variant="body2">{t("rememberRecentMapData")}</Typography>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {t("rememberRecentMapDataDescription")}
                  </Typography>
                </Stack>
              }
              sx={{ alignItems: "flex-start", m: 0 }}
            />
          ) : null}

          {downloading ? (
            <Box>
              <Stack direction="row" sx={{ justifyContent: "space-between", mb: 0.5 }}>
                <Typography variant="body2">{t("downloading")}</Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {Math.round((progress?.progress ?? 0) * 100)}%
                </Typography>
              </Stack>
              <LinearProgress
                variant={progress ? "determinate" : "indeterminate"}
                value={Math.round((progress?.progress ?? 0) * 100)}
              />
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
              >
                {t("tilesProgress", { done: progress?.done ?? 0, total: progress?.total ?? 0 })} ·{" "}
                {formatBytes(progress?.bytes ?? 0)}
              </Typography>
            </Box>
          ) : null}

          {network.metered && !downloading ? (
            <Box>
              <Alert severity="warning" sx={{ mb: 1 }}>
                {t("meteredWarning", { size: formatBytes(sizeEstimateBytes) })}
              </Alert>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={meteredConfirmed}
                    onChange={(e) => setMeteredConfirmed(e.target.checked)}
                  />
                }
                label={t("meteredConfirm")}
              />
            </Box>
          ) : null}

          {tooLarge ? <Alert severity="warning">{t("tooLarge")}</Alert> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel}>{t("cancel")}</Button>
        <Button
          variant="contained"
          onClick={startDownload}
          disabled={!bbox || tooLarge || downloading || (network.metered && !meteredConfirmed)}
        >
          {t("startDownload")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
