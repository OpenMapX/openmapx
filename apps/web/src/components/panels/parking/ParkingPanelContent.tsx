"use client";

import ClearIcon from "@mui/icons-material/Clear";
import DirectionsIcon from "@mui/icons-material/Directions";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Snackbar from "@mui/material/Snackbar";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  formatRelativeTime,
  PANEL,
  useClearParkedLocation,
  useDirectionsStore,
  useParkedLocations,
  useParkingStore,
  useSidebarStore,
  useUpdateParkedLocation,
  useVehicles,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildLocationShareUrl, shareUrl } from "@/lib/deepLink";

/** Quiet period before a typed note reaches the server. */
const NOTE_COMMIT_DEBOUNCE_MS = 600;
/** How often the countdown re-renders. A parking meter does not need seconds. */
const COUNTDOWN_TICK_MS = 30_000;

/** `datetime-local` wants a local wall-clock string, not an instant. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const offset = at.getTimezoneOffset() * 60_000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 16);
}

function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export function ParkingPanelContent() {
  const t = useTranslations("parking");
  const locale = useLocale();
  const { data: parked } = useParkedLocations();
  const { data: vehicles } = useVehicles();
  const selectedId = useParkingStore((s) => s.selectedParkedId);
  const picking = useParkingStore((s) => s.picking);
  const pickedCoords = useParkingStore((s) => s.pickedCoords);
  const update = useUpdateParkedLocation();
  const clear = useClearParkedLocation();

  const record = useMemo(
    () => parked?.find((p) => p.id === selectedId) ?? parked?.[0] ?? null,
    [parked, selectedId],
  );

  const [noteDraft, setNoteDraft] = useState(record?.note ?? "");
  const [toast, setToast] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordId = record?.id ?? null;

  useEffect(() => {
    setNoteDraft(record?.note ?? "");
  }, [record?.note]);

  useEffect(() => () => clearTimeout(noteTimer.current ?? undefined), []);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The record can vanish under an open panel — cleared in another tab, or on
  // another device. Land the user back on the map instead of an empty surface.
  useEffect(() => {
    if (parked !== undefined && parked.length === 0) useSidebarStore.getState().closeAll();
  }, [parked]);

  const updateMutate = update.mutate;
  useEffect(() => {
    if (!pickedCoords || !recordId) return;
    const [lng, lat] = pickedCoords;
    // The stored address described the old position, so it is dropped rather
    // than left pointing somewhere the car no longer is.
    updateMutate({ id: recordId, lat, lng, address: null });
    useParkingStore.getState().setPickedCoords(null);
  }, [pickedCoords, recordId, updateMutate]);

  if (!record) return null;

  const vehicle = vehicles?.find((v) => v.id === record.vehicleId) ?? null;
  const expiresMs = record.expiresAt ? Date.parse(record.expiresAt) : null;
  const remaining = expiresMs === null ? null : expiresMs - tick;

  const commitNote = (value: string) => {
    setNoteDraft(value);
    clearTimeout(noteTimer.current ?? undefined);
    noteTimer.current = setTimeout(
      () => update.mutate({ id: record.id, note: value.trim() === "" ? null : value }),
      NOTE_COMMIT_DEBOUNCE_MS,
    );
  };

  const handleDirections = () => {
    const directions = useDirectionsStore.getState();
    directions.setWaypoint(
      directions.waypoints.length - 1,
      [record.lng, record.lat],
      record.address ?? t("title"),
    );
    directions.open();
    useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
  };

  const handleShare = async () => {
    const url = buildLocationShareUrl(window.location.href, {
      id: `parked-${record.id}`,
      coordinates: [record.lng, record.lat],
      name: t("title"),
    });
    const result = await shareUrl({ url, title: t("title") });
    if (result === "copied") setToast(t("share"));
  };

  const handleClear = () => {
    clear.mutate(record.id);
    useSidebarStore.getState().closeAll();
  };

  return (
    <Box sx={{ px: 2, py: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {t("title")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("savedWhen", { when: formatRelativeTime(Date.parse(record.savedAt), { locale }) })}
        </Typography>
        {vehicle && (
          <Chip size="small" sx={{ mt: 0.5 }} label={t("forVehicle", { name: vehicle.name })} />
        )}
      </Box>

      {record.address && <Typography variant="body2">{record.address}</Typography>}

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Button variant="contained" startIcon={<DirectionsIcon />} onClick={handleDirections}>
          {t("directions")}
        </Button>
        <Button startIcon={<ShareIcon />} onClick={() => void handleShare()}>
          {t("share")}
        </Button>
        <Button color="error" startIcon={<ClearIcon />} onClick={handleClear}>
          {t("clear")}
        </Button>
      </Box>

      <TextField
        size="small"
        fullWidth
        label={t("note")}
        placeholder={t("notePlaceholder")}
        value={noteDraft}
        onChange={(e) => commitNote(e.target.value)}
      />

      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <TextField
          size="small"
          type="datetime-local"
          label={t("expires")}
          value={toLocalInput(record.expiresAt)}
          onChange={(e) =>
            update.mutate({
              id: record.id,
              expiresAt: e.target.value === "" ? null : new Date(e.target.value).toISOString(),
            })
          }
          slotProps={{ inputLabel: { shrink: true } }}
          fullWidth
        />
        {remaining !== null &&
          (remaining <= 0 ? (
            <Chip size="small" color="error" label={t("expired")} />
          ) : (
            <Chip size="small" label={t("timeLeft", { duration: formatRemaining(remaining) })} />
          ))}
      </Box>

      <Button
        startIcon={<EditLocationAltIcon />}
        onClick={() => useParkingStore.getState().setPicking(true)}
        disabled={picking}
      >
        {t("changeLocation")}
      </Button>
      {picking && (
        <Typography variant="caption" color="text.secondary" role="status">
          {t("pickOnMap")}
        </Typography>
      )}

      <Snackbar
        open={toast !== null}
        message={toast}
        autoHideDuration={2500}
        onClose={() => setToast(null)}
      />
    </Box>
  );
}
