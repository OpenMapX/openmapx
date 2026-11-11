"use client";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import {
  apiClient,
  fetchTransitPlan,
  formatDuration,
  formatOverviewDistance,
  haversineDistance,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { transitAlternativeOrigin, transitItineraryFingerprint } from "@openmapx/core/navigation";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { LegBadge } from "@/components/panels/transit/LegBadge";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import Dialog from "@/components/ui/Dialog";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { useMobileRuntimeContext } from "@/lib/mobile/MobileRuntimeProvider";
import { prepareTransitStart } from "@/lib/mobile/transitCapture";

function identity() {
  const s = useNavigationStore.getState();
  return `${s.nativeSessionId ?? s.transitRequestId}:${s.itinerary ? transitItineraryFingerprint(s.itinerary) : ""}`;
}
/** Querying never mutates the followed journey. Only explicit, guarded adoption can do so. */
export function TransitAlternativesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("navigation");
  const td = useTranslations("directions");
  const locale = useLocale();
  const units = useSettingsStore((s) => s.units);
  const fmt = useDateTimeFormat();
  const runtime = useMobileRuntimeContext();
  const itinerary = useNavigationStore((s) => s.itinerary);
  const requestId = useNavigationStore((s) => s.transitRequestId);
  const nativeId = useNavigationStore((s) => s.nativeSessionId);
  const fingerprint = itinerary ? transitItineraryFingerprint(itinerary) : "";
  const [results, setResults] = useState<TripItinerary[]>([]);
  const [loading, setLoading] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const flight = useRef<{
    controller: AbortController;
    identity: string;
    origin: [number, number];
    preview: boolean;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: journey identity and retry nonce invalidate in-flight queries.
  useEffect(() => {
    if (!open) return;
    const store = useNavigationStore.getState();
    if (!store.itinerary) return;
    const from = transitAlternativeOrigin(store.transitProgress, store.itinerary, Date.now());
    setResults([]);
    setError(null);
    setPreview(from?.preview ? (from.name ?? "") : null);
    if (!from) {
      setError("transitAlternativesNeedLocation");
      setLoading(false);
      return;
    }
    const destination = store.itinerary.legs.at(-1)?.to;
    if (!destination) return;
    const run = {
      controller: new AbortController(),
      identity: identity(),
      origin: from.origin,
      preview: from.preview,
    };
    flight.current = run;
    setLoading(true);
    void fetchTransitPlan(
      {
        ...store.transitReplanOptions,
        origin: from.origin,
        destination: [destination.lng, destination.lat],
        time: from.time,
        lang: locale,
      },
      apiClient,
      { signal: run.controller.signal, timeoutMs: 20000 },
    )
      .then((env) => {
        if (!run.controller.signal.aborted && identity() === run.identity)
          setResults((env.data?.itineraries ?? []).slice(0, 5));
      })
      .catch(() => {
        if (!run.controller.signal.aborted) setError("transitAlternativesFailed");
      })
      .finally(() => {
        if (flight.current === run) setLoading(false);
      });
    return () => {
      run.controller.abort();
      if (flight.current === run) flight.current = null;
    };
  }, [open, requestId, nativeId, fingerprint, nonce, locale]);
  const adopt = async (next: TripItinerary) => {
    const run = flight.current;
    const store = useNavigationStore.getState();
    const current = store.itinerary
      ? transitAlternativeOrigin(store.transitProgress, store.itinerary, Date.now())
      : null;
    if (
      !run ||
      run.controller.signal.aborted ||
      identity() !== run.identity ||
      !current ||
      current.preview ||
      run.preview ||
      haversineDistance(run.origin, current.origin) > 150
    ) {
      setError("transitAlternativesRefresh");
      return;
    }
    setAdopting(true);
    setError(null);
    try {
      const built = await prepareTransitStart({
        itinerary: next,
        client: apiClient,
        replanOptions: store.transitReplanOptions as never,
        locale: locale === "de" ? "de" : "en",
        units: useSettingsStore.getState().units,
        settings: {
          voiceEnabled: store.voiceEnabled,
          keepScreenOn: store.keepScreenOn,
          alightAlertsEnabled: true,
        },
        capturedAtMs: Date.now(),
        signal: run.controller.signal,
      });
      if (!built.ok) throw Error("capture");
      if (run.controller.signal.aborted || identity() !== run.identity) return;
      const latest = useNavigationStore.getState();
      const latestOrigin = latest.itinerary
        ? transitAlternativeOrigin(latest.transitProgress, latest.itinerary, Date.now())
        : null;
      if (
        !latestOrigin ||
        latestOrigin.preview ||
        haversineDistance(run.origin, latestOrigin.origin) > 150
      )
        throw Error("position-changed");
      if (latest.transitProgress?.phase === "riding" || latest.status !== "navigating")
        throw Error("changed");
      if (runtime.browserAuthority) {
        latest.replaceItinerary(next);
        latest.setTransitCaptures(built.startPackage.captures);
      } else {
        if (!runtime.commands) throw Error("unavailable");
        await runtime.commands.replace(
          built.startPackage,
          latest.nativeRouteFingerprint ?? fingerprint,
        );
      }
      onClose();
    } catch {
      if (!run.controller.signal.aborted) setError("transitAlternativesFailed");
    } finally {
      setAdopting(false);
    }
  };
  return (
    <Dialog open={open} onClose={adopting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("findTransitAlternatives")}</DialogTitle>
      <DialogContent dividers sx={{ bgcolor: "background.default" }}>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {t("transitAlternativesKeepJourney")}
        </Typography>
        {preview !== null && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t("transitAlternativesPreview", { stop: preview })}
          </Alert>
        )}
        {error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t(error)}
          </Alert>
        )}
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
            <CircularProgress aria-label={t("findingTransitAlternatives")} />
          </Box>
        ) : results.length === 0 && !error ? (
          <Typography>{t("transitAlternativesEmpty")}</Typography>
        ) : null}
        {results.map((trip, index) => {
          const boarding = trip.legs.find((leg) => leg.route);
          return (
            <Box
              key={trip.id ?? `${index}`}
              sx={{
                border: 1,
                borderColor: "divider",
                bgcolor: "background.paper",
                borderRadius: 2,
                p: 2,
                mb: 1.5,
                "&:last-child": { mb: 0 },
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 2,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <Typography
                  variant="body1"
                  sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
                >
                  {fmt.time(trip.startTime)} – {fmt.time(trip.endTime)}
                </Typography>
                <Typography variant="body1" sx={{ fontWeight: 700 }}>
                  {formatDuration(trip.duration, locale)}
                </Typography>
              </Box>
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", mt: 1 }}
              >
                {trip.legs.map((leg, i) => (
                  <Box
                    key={`${leg.tripId ?? leg.mode}:${leg.startTime}:${leg.from.stopId ?? leg.from.name}:${leg.to.stopId ?? leg.to.name}`}
                    sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
                  >
                    {i > 0 && <ChevronRightIcon sx={{ fontSize: 16, color: "text.disabled" }} />}
                    <LegBadge leg={leg} />
                  </Box>
                ))}
                <Typography variant="caption" color="text.secondary">
                  {t("alternativeTransfers", { count: trip.transfers })}
                </Typography>
                {trip.walkDistance > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    ·{" "}
                    {td("walkDistance", {
                      distance: formatOverviewDistance(trip.walkDistance, units),
                    })}
                  </Typography>
                )}
              </Box>
              {boarding && (
                <Box
                  sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", mt: 1 }}
                >
                  <Typography variant="body2" color="text.secondary">
                    {boarding.from.name}
                  </Typography>
                  {boarding.from.platformCode && (
                    <PlatformBadge
                      code={boarding.from.platformCode}
                      scheduledCode={boarding.from.scheduledPlatformCode}
                    />
                  )}
                  {boarding.headsign && (
                    <Typography variant="caption" color="text.secondary">
                      {t("towards", { headsign: boarding.headsign })}
                    </Typography>
                  )}
                </Box>
              )}
              <Button
                disabled={adopting || preview !== null}
                onClick={() => void adopt(trip)}
                variant="outlined"
                fullWidth
                endIcon={<ArrowForwardIcon />}
                sx={{ mt: 1.5, minHeight: 44 }}
              >
                {t("useTransitJourney")}
              </Button>
            </Box>
          );
        })}
      </DialogContent>
      <DialogActions>
        <Button
          startIcon={<RefreshIcon />}
          disabled={loading || adopting}
          onClick={() => setNonce((n) => n + 1)}
        >
          {t("refreshTransitAlternatives")}
        </Button>
        <Button disabled={adopting} onClick={onClose}>
          {t("closeTransitAlternatives")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
