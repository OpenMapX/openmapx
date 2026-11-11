"use client";
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  PANEL,
  transitPlanningCapabilitiesQueryOptions,
  transitPlanQueryKey,
  useDirectionsStore,
  useImportedGeometryStore,
  useNavigationStore,
  useSidebarStore,
} from "@openmapx/core";
import { classifySharedText, type IntakeItem } from "@openmapx/core/navigation";
import {
  createTravelPlanPort,
  resolveSharedTravelPlan,
  TravelPlanResolutionError,
} from "@openmapx/core/navigation/api";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { DEEPLINK_OPEN_EVENT } from "@/lib/deepLink";
import { parseGeoFile } from "@/lib/importGeoFile";
import { useMobileRuntimeContext } from "@/lib/mobile/MobileRuntimeProvider";
import { applyNativeDeepLink } from "@/lib/mobile/nativeDeepLink";
import { IntakeTransferError, NativeIntakeClient } from "@/lib/mobile/nativeIntake";

/** Travel plans open directly; files and other shared content retain their review step. */
export function NativeIntakeHandler() {
  const t = useTranslations("pwa.intake");
  const queryClient = useQueryClient();
  const runtime = useMobileRuntimeContext();
  const pathname = usePathname();
  const router = useRouter();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const enabled =
    runtime.state === "native-compatible" && runtime.handshake?.capabilities.nativeIntake === true;
  const client = useMemo(
    () => (enabled && runtime.client ? new NativeIntakeClient(runtime.client) : null),
    [enabled, runtime.client],
  );
  const navStatus = useNavigationStore((s) => s.status);
  const nativeSessionId = useNavigationStore((s) => s.nativeSessionId);
  const imported = useImportedGeometryStore((s) => s.imported);
  const localBlocked = useCallback(
    () =>
      pathRef.current !== "/" ||
      runtime.commands?.isMutating === true ||
      useNavigationStore.getState().nativeSessionId !== null ||
      !["idle", "planning", "preview"].includes(useNavigationStore.getState().status),
    [runtime.commands],
  );
  const [items, setItems] = useState<IntakeItem[]>([]),
    [selected, setSelected] = useState("");
  const [visible, setVisible] = useState(false),
    [blocked, setBlocked] = useState(true);
  const [listingUnavailable, setListingUnavailable] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [draft, setDraft] = useState(""),
    [scheme, setScheme] = useState("openmapx");
  const [readyItemId, setReadyItemId] = useState("");
  const automaticAttempts = useRef(new Set<string>());
  const observedItems = useRef(new Set<string>());
  const manualOnly = useRef(new Set<string>());
  const [geometry, setGeometry] = useState<GeoJSON.FeatureCollection | null>(null);
  const textIntent = useMemo(
    () =>
      classifySharedText(draft, {
        webOrigin: typeof window === "undefined" ? "https://openmapx.com" : window.location.origin,
        scheme,
      }),
    [draft, scheme],
  );
  const applyAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      applyAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (
      pathname !== "/" ||
      nativeSessionId !== null ||
      !["idle", "planning", "preview"].includes(navStatus)
    )
      applyAbort.current?.abort();
  }, [navStatus, nativeSessionId, pathname]);
  const cancelApply = useCallback(() => {
    applyAbort.current?.abort();
    applyAbort.current = null;
    setBusy(false);
  }, []);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const later = useRef(new Set<string>()),
    generation = useRef(0),
    refreshVersion = useRef(0);
  const selectedItem = items.find((item) => item.id === selected) ?? items[0];
  const selectedId = selectedItem?.id;
  const selectedKind = selectedItem?.kind;
  const selectedItemRef = useRef(selectedItem);
  selectedItemRef.current = selectedItem;
  const refresh = useCallback(async () => {
    if (!client) return;
    const version = ++refreshVersion.current;
    const current = generation.current;
    try {
      const result = await client.list();
      if (generation.current !== current || version !== refreshVersion.current) return;
      setListingUnavailable("");
      setItems(result.items);
      setScheme(result.scheme);
      setBlocked(!result.canApply);
      const pending = result.items.filter((item) => !later.current.has(item.id));
      const received = pending.filter((item) => !observedItems.current.has(item.id));
      observedItems.current = new Set(result.items.map((item) => item.id));
      for (const id of automaticAttempts.current)
        if (!observedItems.current.has(id)) automaticAttempts.current.delete(id);
      for (const id of manualOnly.current)
        if (!observedItems.current.has(id)) manualOnly.current.delete(id);
      const newest = received.reduce<IntakeItem | undefined>(
        (latest, item) => (!latest || item.createdAtMs > latest.createdAtMs ? item : latest),
        undefined,
      );
      if (newest) {
        manualOnly.current.delete(newest.id);
        for (const item of pending) if (item.id !== newest.id) manualOnly.current.add(item.id);
      }
      const next = newest ?? pending.find((item) => !manualOnly.current.has(item.id));
      if (
        result.canApply &&
        !localBlocked() &&
        next &&
        (!visibleRef.current || (received.length > 0 && next.id !== selectedItemRef.current?.id))
      ) {
        if (next.id !== selectedItemRef.current?.id) cancelApply();
        setSelected(next.id);
        setVisible(true);
      }
    } catch (error) {
      if (generation.current !== current || version !== refreshVersion.current) return;
      setBlocked(true);
      setListingUnavailable(
        error instanceof IntakeTransferError && error.code === "navigation-unavailable"
          ? error.code
          : selectedItemRef.current
            ? "unavailable"
            : "",
      );
      // Owned items and edited drafts survive a failed authority check.
    }
  }, [client, localBlocked, cancelApply]);
  useEffect(() => {
    if (pathname !== "/") setVisible(false);
    generation.current++;
    void refresh();
    const stop = runtime.client?.subscribe((message) => {
      if (message.type === "intake.changed" || message.type === "session.stopped") void refresh();
    });
    const foreground = () => {
      if (document.visibilityState !== "hidden") {
        later.current.clear();
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      generation.current++;
      applyAbort.current?.abort();
      stop?.();
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh, runtime.client, pathname]);
  useEffect(() => {
    if (navStatus === "idle" && nativeSessionId === null) void refresh();
  }, [navStatus, nativeSessionId, refresh]);
  useEffect(() => {
    const selectedItem = selectedItemRef.current;
    if (
      !visible ||
      !selectedItem ||
      selectedItem.id !== selectedId ||
      selectedItem.kind !== selectedKind ||
      !client
    )
      return;
    const abort = new AbortController();
    setReadyItemId("");
    setDraft("");
    setGeometry(null);
    setError("");
    if (selectedItem.kind === "error") {
      setLoading(false);
      return;
    }
    setLoading(true);
    void client
      .text(selectedItem, abort.signal)
      .then((text) => {
        if (abort.signal.aborted) return;
        if (selectedItem.kind === "text") setDraft(text);
        else {
          const parsed = parseGeoFile(selectedItem.name, text);
          if (!parsed) setError("invalid-data");
          setGeometry(parsed);
        }
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setError(error instanceof IntakeTransferError ? error.code : "unreadable");
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setReadyItemId(selectedItem.id);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [visible, selectedId, selectedKind, client]);
  function postpone() {
    if (applyAbort.current) cancelApply();
    for (const item of items) later.current.add(item.id);
    setVisible(false);
  }
  async function discard() {
    if (!client || !selectedItem || busy) return;
    setBusy(true);
    try {
      await client.complete(selectedItem.id, "discarded");
      setItems((items) => items.filter((item) => item.id !== selectedItem.id));
      await refresh();
    } catch (error) {
      if (error instanceof IntakeTransferError && error.code === "navigation-active")
        setBlocked(true);
      else if (error instanceof IntakeTransferError && error.code === "navigation-unavailable") {
        setBlocked(true);
        setListingUnavailable(error.code);
      } else setError(error instanceof IntakeTransferError ? error.code : "unavailable");
    } finally {
      setBusy(false);
    }
  }
  const apply = useCallback(async () => {
    if (!client || !selectedItem || busy) return;
    const abort = new AbortController();
    applyAbort.current = abort;
    setBusy(true);
    setError("");
    const documentGeneration = generation.current;
    const itemId = selectedItem.id;
    const fresh = () =>
      !abort.signal.aborted &&
      generation.current === documentGeneration &&
      selectedItemRef.current?.id === itemId;
    try {
      let current = await client.list();
      if (!fresh()) return;
      if (!current.items.some((item) => item.id === itemId)) {
        setError("expired");
        return;
      }
      if (!current.canApply || localBlocked()) {
        automaticAttempts.current.delete(itemId);
        setBlocked(true);
        return;
      }
      let resolved: Awaited<ReturnType<typeof resolveSharedTravelPlan>> | undefined;
      if (selectedItem.kind === "text" && textIntent.kind === "travel-plan") {
        if (useDirectionsStore.getState().requireBikeTransport) {
          setError("trip-bike-requirement");
          return;
        }
        const capabilities = await queryClient.ensureQueryData(
          transitPlanningCapabilitiesQueryOptions(),
        );
        if (!fresh()) return;
        const directions = useDirectionsStore.getState();
        resolved = await resolveSharedTravelPlan(
          textIntent.plan,
          createTravelPlanPort(),
          abort.signal,
          {
            wheelchairRequired: directions.wheelchairRequired,
            requireBikeTransport: directions.requireBikeTransport,
            bikeHillPreference: directions.bikeHillPreference,
            capabilityEpoch:
              capabilities.providers.find((p) => p.id === "transit-motis-local")?.metadata
                ?.datasetEpoch || undefined,
          },
        );
        if (!fresh()) return;
        await queryClient.cancelQueries({
          queryKey: transitPlanQueryKey(resolved.query),
          exact: true,
        });
        if (!fresh()) return;
        // Resolution crossed an async boundary: native ownership/authority must be checked again.
        current = await client.list();
        if (!fresh()) return;
        if (!current.items.some((item) => item.id === itemId)) {
          setError("expired");
          return;
        }
        if (!current.canApply || localBlocked()) {
          automaticAttempts.current.delete(itemId);
          setBlocked(true);
          return;
        }
      }
      // No await between the final authority check and synchronous publication.
      if (selectedItem.kind === "file" && geometry)
        useImportedGeometryStore
          .getState()
          .setImported({ name: selectedItem.name, geojson: geometry });
      else if (selectedItem.kind === "text") {
        if (textIntent.kind === "travel-plan" && resolved) {
          queryClient.setQueryData(transitPlanQueryKey(resolved.query), resolved.plan);
          if (!useDirectionsStore.getState().openTransitSelection(resolved))
            throw new TravelPlanResolutionError("unavailable");
          useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
        } else if (textIntent.kind === "map") {
          applyNativeDeepLink(textIntent, {
            replaceSearch: (query) => {
              const url = new URL(window.location.href);
              url.search = query;
              window.history.replaceState(window.history.state, "", url.toString());
            },
            notify: () => window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT)),
            showActiveNavigation: () => undefined,
            requestSnapshot: () => undefined,
          });
        } else {
          setError("unsupported");
          return;
        }
      } else return;
      await client.complete(itemId, "opened");
      if (!fresh()) return;
      later.current.add(itemId);
      setVisible(false);
      await refresh();
    } catch (error) {
      if (!fresh()) return;
      if (error instanceof TravelPlanResolutionError)
        setError(
          error.code === "ambiguous"
            ? "trip-ambiguous"
            : error.code === "invalid"
              ? "trip-invalid"
              : error.code === "not-found"
                ? "trip-unavailable"
                : "unavailable",
        );
      else if (error instanceof IntakeTransferError && error.code === "navigation-active")
        setBlocked(true);
      else if (error instanceof IntakeTransferError && error.code === "navigation-unavailable") {
        setBlocked(true);
        setListingUnavailable(error.code);
      } else setError(error instanceof IntakeTransferError ? error.code : "unavailable");
    } finally {
      if (abort.signal.aborted) automaticAttempts.current.delete(itemId);
      if (applyAbort.current === abort) {
        applyAbort.current = null;
        setBusy(false);
      }
    }
  }, [client, selectedItem, busy, localBlocked, textIntent, queryClient, geometry, refresh]);
  useEffect(() => {
    if (
      !visible ||
      !selectedId ||
      readyItemId !== selectedId ||
      selectedKind !== "text" ||
      textIntent.kind !== "travel-plan" ||
      busy ||
      error ||
      blocked ||
      localBlocked() ||
      manualOnly.current.has(selectedId) ||
      automaticAttempts.current.has(selectedId)
    )
      return;
    automaticAttempts.current.add(selectedId);
    void apply();
  }, [
    visible,
    selectedId,
    selectedKind,
    readyItemId,
    textIntent,
    busy,
    error,
    blocked,
    localBlocked,
    apply,
  ]);
  if (!client) return null;
  if (listingUnavailable)
    return (
      <Alert
        severity="warning"
        sx={{
          position: "fixed",
          top: "calc(128px + var(--omx-safe-top, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          width: "calc(100% - 32px)",
          maxWidth: 520,
          zIndex: 1301,
        }}
        action={<Button onClick={() => void refresh()}>{t("retry")}</Button>}
      >
        {t(
          listingUnavailable === "navigation-unavailable"
            ? "navigationUnavailable"
            : "listingUnavailable",
        )}
      </Alert>
    );
  if (!items.length) return null;
  const waiting = blocked || localBlocked();
  const invalidText =
    selectedItem?.kind === "text" && textIntent.kind !== "map" && textIntent.kind !== "travel-plan";
  const code = selectedItem?.kind === "error" ? selectedItem.errorCode : error;
  const openingDirectly =
    visible &&
    selectedKind === "text" &&
    !manualOnly.current.has(selectedId ?? "") &&
    (busy || !automaticAttempts.current.has(selectedId ?? "")) &&
    !waiting &&
    !code &&
    (readyItemId !== selectedId || textIntent.kind === "travel-plan");
  return (
    <>
      {!openingDirectly && (
        <Button
          variant="contained"
          onClick={() => {
            if (pathRef.current !== "/") {
              router.push("/");
              return;
            }
            setVisible(true);
            void refresh();
          }}
          sx={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            top: "calc(128px + var(--omx-safe-top, 0px))",
            zIndex: 1100,
          }}
        >
          {t("pending", { count: items.length })}
        </Button>
      )}
      <Dialog
        open={visible && !openingDirectly}
        onClose={busy && textIntent.kind !== "travel-plan" ? undefined : postpone}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {items.length > 1 && (
              <TextField
                select
                label={t("item")}
                value={selectedItem?.id ?? ""}
                onChange={(event) => setSelected(event.target.value)}
                disabled={busy}
              >
                {items.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {item.kind === "text" ? t("sharedLocation") : item.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <Typography sx={{ overflowWrap: "anywhere" }}>
              {selectedItem?.kind === "text"
                ? t(textIntent.kind === "travel-plan" ? "sharedTrip" : "sharedLocation")
                : selectedItem?.name}
            </Typography>
            {waiting && <Alert severity="info">{t("deferred")}</Alert>}
            {items.some((item) => item.kind === "error") && selectedItem?.kind !== "error" && (
              <Alert severity="warning">{t("partial")}</Alert>
            )}
            {loading && <Typography role="status">{t("loading")}</Typography>}
            {code && (
              <Alert severity="error">
                {t(
                  ((
                    {
                      "too-large": "tooLarge",
                      "too-many": "tooMany",
                      "inbox-full": "inboxFull",
                      expired: "expired",
                      unsupported: "unsupported",
                      "trip-ambiguous": "tripAmbiguous",
                      "trip-invalid": "tripInvalid",
                      "trip-unavailable": "tripUnavailable",
                      "trip-bike-requirement": "tripBikeRequirement",
                    } as Record<string, string>
                  )[code] ?? "failed") as "failed",
                )}
              </Alert>
            )}
            {textIntent.kind === "invalid-travel-plan" &&
              selectedItem?.kind === "text" &&
              !loading && (
                <Alert severity="warning">
                  {t(textIntent.reason === "missing-text" ? "tripMissingText" : "tripInvalid")}
                </Alert>
              )}
            {busy && textIntent.kind === "travel-plan" && (
              <Typography role="status">{t("loading")}</Typography>
            )}
            {selectedItem?.kind === "text" && textIntent.kind !== "travel-plan" && !loading && (
              <TextField
                label={t(textIntent.kind === "invalid-travel-plan" ? "tripText" : "search")}
                disabled={busy}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                multiline
                slotProps={{ htmlInput: { maxLength: 4096 } }}
                helperText={
                  textIntent.kind === "invalid-travel-plan"
                    ? undefined
                    : invalidText
                      ? t("editUnsupported")
                      : t("textHelp")
                }
              />
            )}
            {geometry && (
              <Typography>
                {t("features", {
                  count: geometry.features.length,
                  format:
                    selectedItem?.kind === "file"
                      ? { gpx: "GPX", geojson: "GeoJSON", kml: "KML" }[selectedItem.format]
                      : "",
                })}
              </Typography>
            )}
            {geometry && imported && (
              <Alert severity="warning">{t("replace", { name: imported.name })}</Alert>
            )}
            <Typography variant="body2" color="text.secondary">
              {t("retention")}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ flexWrap: "wrap" }}>
          <Button onClick={() => void discard()} disabled={busy}>
            {t("discard")}
          </Button>
          <Button onClick={postpone} disabled={busy && textIntent.kind !== "travel-plan"}>
            {t("later")}
          </Button>
          {selectedItem?.kind !== "error" && (
            <Button
              variant="contained"
              onClick={() => void apply()}
              disabled={
                busy ||
                loading ||
                waiting ||
                Boolean(invalidText) ||
                (selectedItem?.kind === "file" && !geometry)
              }
            >
              {t(selectedItem?.kind === "file" ? (imported ? "replaceAction" : "import") : "open")}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
