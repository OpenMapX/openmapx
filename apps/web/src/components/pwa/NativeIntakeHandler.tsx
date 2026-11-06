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
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { DEEPLINK_OPEN_EVENT } from "@/lib/deepLink";
import { parseGeoFile } from "@/lib/importGeoFile";
import { useMobileRuntimeContext } from "@/lib/mobile/MobileRuntimeProvider";
import { applyNativeDeepLink } from "@/lib/mobile/nativeDeepLink";
import { IntakeTransferError, NativeIntakeClient } from "@/lib/mobile/nativeIntake";

/** User confirmation is the only path from owned inbox bytes to map state. */
export function NativeIntakeHandler() {
  const t = useTranslations("pwa.intake");
  const runtime = useMobileRuntimeContext();
  const pathname = usePathname();
  const router = useRouter();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const enabled =
    runtime.state === "native-compatible" &&
    runtime.handshake?.selectedProtocolVersion === 4 &&
    runtime.handshake.capabilities.nativeIntake === true;
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
    if (nativeSessionId !== null || !["idle", "planning", "preview"].includes(navStatus))
      applyAbort.current?.abort();
  }, [navStatus, nativeSessionId]);
  function cancelApply() {
    applyAbort.current?.abort();
    applyAbort.current = null;
    setBusy(false);
  }
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
      if (
        result.canApply &&
        !localBlocked() &&
        result.items.some((item) => !later.current.has(item.id)) &&
        !visibleRef.current
      ) {
        setSelected(result.items.find((item) => !later.current.has(item.id))?.id ?? "");
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
  }, [client, localBlocked]);
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
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [visible, selectedId, selectedKind, client]);
  function postpone() {
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
  async function apply() {
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
        setBlocked(true);
        return;
      }
      let resolved: Awaited<ReturnType<typeof resolveSharedTravelPlan>> | undefined;
      if (selectedItem.kind === "text" && textIntent.kind === "travel-plan") {
        resolved = await resolveSharedTravelPlan(
          textIntent.plan,
          createTravelPlanPort(),
          abort.signal,
        );
        if (!fresh()) return;
        // Resolution crossed an async boundary: native ownership/authority must be checked again.
        current = await client.list();
        if (!fresh()) return;
        if (!current.items.some((item) => item.id === itemId)) {
          setError("expired");
          return;
        }
        if (!current.canApply || localBlocked()) {
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
          useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
          useDirectionsStore.getState().openImportedTransitTrip(textIntent.plan, resolved);
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
              : "trip-unavailable",
        );
      else if (error instanceof IntakeTransferError && error.code === "navigation-active")
        setBlocked(true);
      else if (error instanceof IntakeTransferError && error.code === "navigation-unavailable") {
        setBlocked(true);
        setListingUnavailable(error.code);
      } else setError(error instanceof IntakeTransferError ? error.code : "unavailable");
    } finally {
      if (applyAbort.current === abort) {
        applyAbort.current = null;
        setBusy(false);
      }
    }
  }
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
  return (
    <>
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
      <Dialog open={visible} onClose={busy ? undefined : postpone} fullWidth maxWidth="sm">
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
              {selectedItem?.kind === "text" ? t("sharedLocation") : selectedItem?.name}
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
                    } as Record<string, string>
                  )[code] ?? "failed") as "failed",
                )}
              </Alert>
            )}
            {textIntent.kind === "travel-plan" && selectedItem?.kind === "text" && !loading && (
              <Stack spacing={1}>
                <Typography sx={{ fontWeight: 600 }}>{textIntent.plan.sourceLabel}</Typography>
                <Typography>
                  {textIntent.plan.origin} → {textIntent.plan.destination}
                </Typography>
                {textIntent.plan.legs.map((leg) => (
                  <Typography key={`${leg.trainNumber}-${leg.departure}`} variant="body2">
                    {leg.service} ({leg.trainNumber}) · {leg.departure.replace("T", " ")} →{" "}
                    {leg.arrival.replace("T", " ")}
                  </Typography>
                ))}
                <Alert severity="info">{t("tripHelp")}</Alert>
              </Stack>
            )}
            {textIntent.kind === "invalid-travel-plan" &&
              selectedItem?.kind === "text" &&
              !loading && (
                <Alert severity="warning">
                  {t(textIntent.reason === "missing-text" ? "tripMissingText" : "tripInvalid")}
                </Alert>
              )}
            {busy && textIntent.kind === "travel-plan" && (
              <Typography role="status">{t("resolvingTrip")}</Typography>
            )}
            {selectedItem?.kind === "text" && !loading && (
              <TextField
                label={t(
                  textIntent.kind === "travel-plan" || textIntent.kind === "invalid-travel-plan"
                    ? "tripText"
                    : "search",
                )}
                disabled={busy}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                multiline
                slotProps={{ htmlInput: { maxLength: 4096 } }}
                helperText={
                  textIntent.kind === "travel-plan" || textIntent.kind === "invalid-travel-plan"
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
          {busy && textIntent.kind === "travel-plan" && (
            <Button onClick={cancelApply}>{t("cancelTrip")}</Button>
          )}
          <Button onClick={() => void discard()} disabled={busy}>
            {t("discard")}
          </Button>
          <Button onClick={postpone} disabled={busy}>
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
