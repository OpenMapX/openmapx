"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
import { createOfflinePackageStorage } from "@/lib/offlineAreas";
import {
  isStoragePersisted,
  persistentStorageSupported,
  requestPersistentStorage,
} from "@/lib/persistentStorage";
import {
  clearRecentMapDataCache,
  getStoredQueryCacheBytes,
  isRecentMapDataCacheEnabled,
  isRecentMapDataQueryKey,
  setRecentMapDataCacheEnabled,
} from "@/lib/recentMapDataCache";
import { formatBytes } from "@/lib/storageFormat";
import {
  CLEARABLE_TILE_CACHES,
  MAP_TILE_CACHE,
  STREET_LEVEL_IMAGERY_TILE_CACHE,
  VECTOR_TILE_CACHE,
} from "@/lib/swCaches";
import { ActionRow, Section, SwitchRow, ValueRow } from "./settingsPrimitives";

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
  "openmapx-preferences": "preferences",
  [MAP_TILE_CACHE]: "mapTiles",
  [STREET_LEVEL_IMAGERY_TILE_CACHE]: "mapTiles",
  [VECTOR_TILE_CACHE]: "vectorTiles",
  "api-geodata": "apiResponses",
  "api-category-search": "apiResponses",
  "api-autocomplete": "apiResponses",
  "api-weather": "apiResponses",
  "api-photos": "apiResponses",
  "api-landmark-coverage": "apiResponses",
  "api-landmark-cells": "apiResponses",
  "api-landmark-models": "apiResponses",
};

// "Clear cached tiles" empties the worker's tile caches (CLEARABLE_TILE_CACHES).
// Downloaded package archives live in OPFS/IndexedDB and are intentionally preserved.
async function inspectStorage(t: (key: string) => string): Promise<StorageInfo> {
  const total = { used: 0, quota: 0, percent: 0 };
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    total.used = est.usage ?? 0;
    total.quota = est.quota ?? 0;
    total.percent = total.quota > 0 ? Math.round((total.used / total.quota) * 100) : 0;
  }

  const rows: CacheRow[] = [];
  const queryCacheBytes = await getStoredQueryCacheBytes();
  if (queryCacheBytes > 0) {
    rows.push({
      cacheName: "openmapx-query-cache",
      label: t("recentMapDataCache"),
      bytes: queryCacheBytes,
      count: 1,
    });
  }

  try {
    const packages = await createOfflinePackageStorage().list();
    const packageBytes = packages.reduce((sum, record) => sum + record.bytesReceived, 0);
    if (packageBytes > 0) {
      rows.push({
        cacheName: "offline-package-archives",
        label: t("offlinePackages"),
        bytes: packageBytes,
        count: packages.length,
      });
    }
  } catch {
    // IndexedDB/OPFS may be unavailable in private browsing; Cache Storage
    // inspection below still provides useful information.
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
    const labelKey = name.startsWith("offline-package-glyphs-")
      ? "offlinePackages"
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
  const tc = useTranslations("common");
  const fullScreen = useFullScreenOnMobile();
  const queryClient = useQueryClient();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [recentMapDataCacheEnabled, setRecentMapDataCacheEnabledState] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const persistSupported = persistentStorageSupported();

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [storageInfo, isPersisted] = await Promise.all([
        inspectStorage(t as unknown as (key: string) => string),
        isStoragePersisted(),
      ]);
      setInfo(storageInfo);
      setPersisted(isPersisted);
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setRecentMapDataCacheEnabledState(isRecentMapDataCacheEnabled());
    void refresh();
  }, [open, refresh]);

  const handleRecentMapDataCacheChange = async (enabled: boolean) => {
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

  const handleEnablePersist = async () => {
    setBusy(true);
    try {
      await requestPersistentStorage();
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
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {t("storageTitle")}
        <IconButton onClick={onClose} aria-label={tc("close")} edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ px: 0, pt: 0 }} aria-busy={busy}>
        <Typography variant="body2" sx={{ px: 3, pt: 2, color: "text.secondary" }}>
          {t("storageDescription")}
        </Typography>

        {info && (info.total.quota > 0 || info.rows.length > 0) && (
          <Section title={t("storageUsage")}>
            {info.total.quota > 0 && (
              <Box sx={{ px: 3, pb: 1 }}>
                <Typography variant="body2" sx={{ mb: 0.75 }}>
                  {t("totalUsed", {
                    used: formatBytes(info.total.used),
                    total: formatBytes(info.total.quota),
                    percent: info.total.percent,
                  })}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={info.total.percent}
                  sx={{ height: 6, borderRadius: 3 }}
                />
              </Box>
            )}
            {info.rows.map((row) => (
              <ValueRow key={row.label} label={row.label} value={formatBytes(row.bytes)} />
            ))}
          </Section>
        )}

        {persistSupported && persisted !== null && (
          <Section title={t("persistentStorageTitle")}>
            <Typography
              variant="body2"
              sx={{ px: 3, pb: persisted ? 1.5 : 1, color: "text.secondary" }}
            >
              {persisted ? t("persistentStorageOn") : t("persistentStorageOff")}
            </Typography>
            {!persisted && (
              <Box sx={{ px: 3, pb: 1.5 }}>
                <Button variant="tonal" onClick={handleEnablePersist} disabled={busy}>
                  {t("enablePersistentStorage")}
                </Button>
              </Box>
            )}
          </Section>
        )}

        <Section title={t("storageMapData")}>
          <SwitchRow
            label={t("rememberRecentMapData")}
            description={t("rememberRecentMapDataDescription")}
            checked={recentMapDataCacheEnabled}
            disabled={busy}
            onChange={(enabled) => void handleRecentMapDataCacheChange(enabled)}
          />
          <ActionRow
            label={t("clearRecentMapData")}
            description={t("clearRecentMapDataDescription")}
            onClick={() => void handleClearRecentMapData()}
            disabled={busy}
          />
          <ActionRow
            label={t("clearTiles")}
            description={t("clearTilesDescription")}
            onClick={() => void handleClearTiles()}
            disabled={busy}
          />
        </Section>
      </DialogContent>
    </Dialog>
  );
}
