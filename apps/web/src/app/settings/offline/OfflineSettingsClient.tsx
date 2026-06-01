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
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AreaGeometry, AutocompleteResult, BBox } from "@openmapx/core";
import {
  createPlace,
  idsFromPrimaryOrCoords,
  useAutocomplete,
  useDebounce,
  usePlaceDetails,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { loadOpenMapXStyle, maptilerStyleUrl } from "@/lib/map";
import {
  countTiles,
  type DownloadProgress,
  deleteAreaCache,
  downloadArea,
  listAreas,
  type OfflineArea,
  type OfflineAreaBbox,
  removeArea,
  saveArea,
} from "@/lib/offlineAreas";
import { requestPersistentStorage } from "@/lib/persistentStorage";
import { formatBytes } from "@/lib/storageFormat";
import { AreaPickerMap } from "./AreaPickerMap";
import { OfflineMapView } from "./OfflineMapView";

const MIN_ZOOM_LIMIT = 0;
const MAX_ZOOM_LIMIT = 18;
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 14;
const TOO_MANY_TILES = 50_000;
// Half-size of the fallback bbox when a searched region has no boundary/extent.
const FALLBACK_REGION_HALF_DEG = 0.15;

/** Derive a [west, south, east, north] extent from a Polygon/MultiPolygon. */
function bboxFromGeometry(geometry: AreaGeometry): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return [west, south, east, north];
}

export function OfflineSettingsClient() {
  const t = useTranslations("settings");
  const [areas, setAreas] = useState<OfflineArea[]>([]);
  const [adding, setAdding] = useState(false);
  const [overview, setOverview] = useState(false);

  useEffect(() => {
    setAreas(listAreas());
  }, []);

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
      <AreaList areas={areas} onChange={refresh} />
      {adding ? (
        <DownloadAreaDialog
          open={adding}
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
      const [w, s, e, n] = bboxFromGeometry(regionBoundary);
      return { west: w, south: s, east: e, north: n };
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
  const sizeEstimateBytes = tileEstimate * 8 * 1024; // assume ~8 KB / vector tile

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

      saveArea(area);
      area = await downloadArea(area, { styles, signal, onProgress: setProgress });
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

          {tooLarge ? <Alert severity="warning">{t("tooLarge")}</Alert> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel}>{t("cancel")}</Button>
        <Button
          variant="contained"
          onClick={startDownload}
          disabled={!bbox || tooLarge || downloading}
        >
          {t("startDownload")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
