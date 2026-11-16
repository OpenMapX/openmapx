"use client";

import ClearIcon from "@mui/icons-material/Clear";
import DirectionsIcon from "@mui/icons-material/Directions";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import LocationOnOutlinedIcon from "@mui/icons-material/LocationOnOutlined";
import ScheduleIcon from "@mui/icons-material/Schedule";
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
  useReverseGeocoding,
  useSidebarStore,
  useUpdateParkedLocation,
  useVehicles,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { buildLocationShareUrl, shareUrl } from "@/lib/deepLink";
import { LocationCardAction } from "../locationCard";
import { useParkingAddressBackfill } from "./useSaveParking";

/** Quiet period before a typed note reaches the server. */
const NOTE_COMMIT_DEBOUNCE_MS = 600;
/** How often the countdown re-renders. A parking meter does not need seconds. */
const COUNTDOWN_TICK_MS = 30_000;

/** The expiry field takes a local wall-clock string, not an instant. */
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
  const tm = useTranslations("mapContextMenu");
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
  // A typed note the server has not been sent yet, with the record it belongs to.
  const pendingNote = useRef<{ id: string; note: string | null } | null>(null);
  const updateRef = useRef(update.mutate);
  updateRef.current = update.mutate;
  const recordId = record?.id ?? null;
  // While the field has focus or a typed note is still queued, a refetch can
  // only carry text the user has already typed past, so it must not replace
  // the draft. A different record always replaces it.
  const noteFocused = useRef(false);
  const syncedRecordId = useRef(recordId);
  const serverNote = record?.note ?? "";

  const cancelPendingNote = useCallback(() => {
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    noteTimer.current = null;
    pendingNote.current = null;
  }, []);
  // Sends the waiting note now. Clearing it first means the debounce timer and
  // the unmount flush can never both send it, and a note already saved is not
  // sent again.
  const flushPendingNote = useCallback(() => {
    const pending = pendingNote.current;
    cancelPendingNote();
    if (pending) updateRef.current(pending);
  }, [cancelPendingNote]);

  useEffect(() => {
    const switched = syncedRecordId.current !== recordId;
    syncedRecordId.current = recordId;
    const editing = noteFocused.current || pendingNote.current?.id === recordId;
    if (!switched && editing) return;
    setNoteDraft(serverNote);
  }, [recordId, serverNote]);

  // Closing the panel inside the debounce window must not drop the note.
  useEffect(() => flushPendingNote, [flushPendingNote]);

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
  const backfillAddress = useParkingAddressBackfill();
  useEffect(() => {
    if (!pickedCoords || !recordId) return;
    const [lng, lat] = pickedCoords;
    // The stored address described the old position, so it is dropped rather
    // than left pointing somewhere the car no longer is.
    updateMutate({ id: recordId, lat, lng, address: null });
    void backfillAddress(recordId, [lng, lat]);
    useParkingStore.getState().setPickedCoords(null);
  }, [pickedCoords, recordId, updateMutate, backfillAddress]);

  // Shown from the record; a spot whose save-time lookup failed is looked up here.
  const { data: reverse } = useReverseGeocoding(
    record && !record.address ? [record.lng, record.lat] : null,
    locale,
  );

  if (!record) return null;
  const address = record.address ?? reverse?.address ?? null;

  const vehicle = vehicles?.find((v) => v.id === record.vehicleId) ?? null;
  const expiresMs = record.expiresAt ? Date.parse(record.expiresAt) : null;
  const remaining = expiresMs === null ? null : expiresMs - tick;

  const commitNote = (value: string) => {
    setNoteDraft(value);
    if (pendingNote.current && pendingNote.current.id !== record.id) flushPendingNote();
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    pendingNote.current = { id: record.id, note: value.trim() === "" ? null : value };
    noteTimer.current = setTimeout(flushPendingNote, NOTE_COMMIT_DEBOUNCE_MS);
  };

  const handleDirections = () => {
    const directions = useDirectionsStore.getState();
    directions.setWaypoint(
      directions.waypoints.length - 1,
      [record.lng, record.lat],
      address ?? t("title"),
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
    if (result === "unavailable") setToast(tm("shareFailed"));
    else if (result === "copied") setToast(tm("linkCopied"));
  };

  const handleClear = () => {
    // The record is going away; a note for it would only be written to nothing.
    cancelPendingNote();
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

      <Box sx={{ display: "flex", gap: 1, overflowX: "auto", scrollbarWidth: "none" }}>
        <LocationCardAction
          primary
          icon={<DirectionsIcon />}
          label={t("directions")}
          onClick={handleDirections}
        />
        <LocationCardAction
          icon={<ShareIcon />}
          label={t("share")}
          onClick={() => void handleShare()}
        />
        <LocationCardAction icon={<ClearIcon />} label={t("clear")} onClick={handleClear} />
      </Box>

      <DetailRow icon={<LocationOnOutlinedIcon />}>
        {address && <Typography>{address}</Typography>}
        <Button
          size="small"
          onClick={() => useParkingStore.getState().setPicking(true)}
          disabled={picking}
          sx={{ ml: -1, px: 1 }}
        >
          {t("changeLocation")}
        </Button>
        {picking && (
          <Typography
            variant="caption"
            color="text.secondary"
            role="status"
            sx={{ display: "block" }}
          >
            {t("pickOnMap")}
          </Typography>
        )}
      </DetailRow>

      <DetailRow icon={<EditNoteOutlinedIcon />}>
        <TextField
          size="small"
          fullWidth
          label={t("note")}
          placeholder={t("notePlaceholder")}
          value={noteDraft}
          onChange={(e) => commitNote(e.target.value)}
          onFocus={() => {
            noteFocused.current = true;
          }}
          onBlur={() => {
            noteFocused.current = false;
          }}
        />
      </DetailRow>

      <DetailRow icon={<ScheduleIcon />}>
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
          <DateTimeField
            label={t("expires")}
            dateLabel={t("expires")}
            value={toLocalInput(record.expiresAt)}
            clearable
            onChange={(next) =>
              update.mutate({
                id: record.id,
                expiresAt: next === "" ? null : new Date(next).toISOString(),
              })
            }
          />
          {remaining !== null &&
            (remaining <= 0 ? (
              <Chip size="small" color="error" label={t("expired")} />
            ) : (
              <Chip size="small" label={t("timeLeft", { duration: formatRemaining(remaining) })} />
            ))}
        </Box>
      </DetailRow>

      <Snackbar
        open={toast !== null}
        message={toast}
        autoHideDuration={2500}
        onClose={() => setToast(null)}
      />
    </Box>
  );
}

/** A detail of the parked spot, behind an icon in the place rows' column. */
function DetailRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
      <Box sx={{ display: "flex", color: "text.secondary", pt: 0.75, "& svg": { fontSize: 22 } }}>
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}
