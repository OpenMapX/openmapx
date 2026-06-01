"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import Alert from "@mui/material/Alert";
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
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { loadOpenMapXStyle, maptilerStyleUrl } from "@/lib/map";
import {
  countTiles,
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

const MIN_ZOOM_LIMIT = 0;
const MAX_ZOOM_LIMIT = 18;
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 14;
const TOO_MANY_TILES = 50_000;

export function OfflineSettingsClient() {
  const t = useTranslations("settings");
  const [areas, setAreas] = useState<OfflineArea[]>([]);
  const [adding, setAdding] = useState(false);

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
      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={() => setAdding(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        {t("downloadNewArea")}
      </Button>
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
    </Stack>
  );
}

function AreaList({ areas, onChange }: { areas: OfflineArea[]; onChange: () => void }) {
  const t = useTranslations("settings");
  const [removing, setRemoving] = useState<OfflineArea | null>(null);

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
              <ListItemText
                primary={area.name}
                secondary={<AreaSecondary area={area} />}
                slotProps={{ secondary: { component: "div" } }}
              />
            </ListItem>
          ))}
        </List>
      </Paper>

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
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      area = await downloadArea(area, { styles, signal });
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

          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("moveToSelect")}
          </Typography>

          <AreaPickerMap initialCenter={initialCenter} initialZoom={5} onChange={handleMapChange} />

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

          {tooLarge ? <Alert severity="warning">{t("tooLarge")}</Alert> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel} disabled={downloading}>
          {t("cancel")}
        </Button>
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
