"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import {
  clearRecentMapDataCache,
  getStoredQueryCacheBytes,
  isRecentMapDataCacheEnabled,
  isRecentMapDataQueryKey,
  setRecentMapDataCacheEnabled,
} from "@/lib/recentMapDataCache";
import { formatBytes } from "@/lib/storageFormat";

interface CacheRow {
  cacheName: string;
  label: string;
  bytes: number;
  count: number;
}

interface StorageInfo {
  total: { used: number; quota: number; percent: number };
  rows: CacheRow[];
}

const ROW_LABELS: Record<string, string> = {
  "static-assets": "appShell",
  pages: "appShell",
  "app-shell-v1": "appShell",
  "openmapx-preferences": "preferences",
  "map-tiles": "mapTiles",
  "mapillary-tiles": "mapTiles",
  "vector-tiles": "vectorTiles",
  "api-geodata": "apiResponses",
  "api-category-search": "apiResponses",
  "api-autocomplete": "apiResponses",
  "api-weather": "apiResponses",
  "api-photos": "apiResponses",
};

// Caches we let "Clear cached tiles" wipe. User-downloaded offline areas
// (`offline-area-*`) are intentionally preserved.
const CLEARABLE_TILE_CACHES = ["map-tiles", "mapillary-tiles", "vector-tiles"];

async function inspectStorage(t: (key: string) => string): Promise<StorageInfo> {
  const total = { used: 0, quota: 0, percent: 0 };
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    total.used = est.usage ?? 0;
    total.quota = est.quota ?? 0;
    total.percent = total.quota > 0 ? Math.round((total.used / total.quota) * 100) : 0;
  }

  const rows: CacheRow[] = [];
  const queryCacheBytes = getStoredQueryCacheBytes();
  if (queryCacheBytes > 0) {
    rows.push({
      cacheName: "openmapx-query-cache",
      label: t("recentMapDataCache"),
      bytes: queryCacheBytes,
      count: 1,
    });
  }

  if (typeof caches === "undefined") return { total, rows };

  const names = await caches.keys();
  for (const name of names) {
    const cache = await caches.open(name);
    const reqs = await cache.keys();
    let bytes = 0;
    for (const req of reqs) {
      const res = await cache.match(req);
      if (!res) continue;
      const lengthHeader = res.headers.get("content-length");
      if (lengthHeader) {
        const n = Number(lengthHeader);
        if (Number.isFinite(n) && n > 0) {
          bytes += n;
          continue;
        }
      }
      try {
        const buf = await res.clone().arrayBuffer();
        bytes += buf.byteLength;
      } catch {
        // ignore
      }
    }
    const labelKey = name.startsWith("offline-area-")
      ? "offlineAreas"
      : (ROW_LABELS[name] ?? "apiResponses");
    rows.push({ cacheName: name, label: t(labelKey), bytes, count: reqs.length });
  }

  // Group by label
  const grouped = new Map<string, CacheRow>();
  for (const row of rows) {
    const existing = grouped.get(row.label);
    if (existing) {
      existing.bytes += row.bytes;
      existing.count += row.count;
    } else {
      grouped.set(row.label, { ...row });
    }
  }

  return { total, rows: Array.from(grouped.values()).sort((a, b) => b.bytes - a.bytes) };
}

export function StorageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("settings");
  const queryClient = useQueryClient();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [recentMapDataCacheEnabled, setRecentMapDataCacheEnabledState] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setInfo(await inspectStorage(t as unknown as (key: string) => string));
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setRecentMapDataCacheEnabledState(isRecentMapDataCacheEnabled());
    void refresh();
  }, [open, refresh]);

  const handleRecentMapDataCacheChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    setRecentMapDataCacheEnabledState(enabled);
    setBusy(true);
    try {
      await setRecentMapDataCacheEnabled(enabled);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleClearRecentMapData = async () => {
    setBusy(true);
    try {
      await queryClient.cancelQueries({
        predicate: (query) => isRecentMapDataQueryKey(query.queryKey),
      });
      queryClient.removeQueries({ predicate: (query) => isRecentMapDataQueryKey(query.queryKey) });
      await clearRecentMapDataCache();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleClearTiles = async () => {
    if (typeof caches === "undefined") return;
    setBusy(true);
    try {
      await Promise.all(CLEARABLE_TILE_CACHES.map((name) => caches.delete(name)));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("storageTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>{t("storageDescription")}</DialogContentText>

        <Box sx={{ mb: 2 }}>
          <FormControlLabel
            control={
              <Switch
                checked={recentMapDataCacheEnabled}
                disabled={busy}
                onChange={(event) => {
                  void handleRecentMapDataCacheChange(event);
                }}
              />
            }
            label={
              <Stack spacing={0.5}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {t("rememberRecentMapData")}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {t("rememberRecentMapDataDescription")}
                </Typography>
              </Stack>
            }
            sx={{ alignItems: "flex-start", m: 0 }}
          />
        </Box>

        {info?.total.quota ? (
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {t("totalUsed", {
                used: formatBytes(info.total.used),
                total: formatBytes(info.total.quota),
                percent: info.total.percent,
              })}
            </Typography>
            <LinearProgress variant="determinate" value={info.total.percent} />
          </Box>
        ) : null}

        <Stack spacing={1}>
          {info?.rows.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              —
            </Typography>
          ) : (
            info?.rows.map((row) => (
              <Stack
                key={row.label}
                direction="row"
                sx={{
                  justifyContent: "space-between",
                  py: 0.5,
                }}
              >
                <Typography variant="body2">{row.label}</Typography>
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {formatBytes(row.bytes)}
                </Typography>
              </Stack>
            ))
          )}
        </Stack>

        <Divider sx={{ my: 3 }} />

        <Stack spacing={2}>
          <Box>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("clearRecentMapDataDescription")}
            </Typography>
            <Button color="warning" onClick={handleClearRecentMapData} disabled={busy}>
              {t("clearRecentMapData")}
            </Button>
          </Box>

          <Box>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("clearTilesDescription")}
            </Typography>
            <Button color="warning" onClick={handleClearTiles} disabled={busy}>
              {t("clearTiles")}
            </Button>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("cancel")}</Button>
      </DialogActions>
    </Dialog>
  );
}
