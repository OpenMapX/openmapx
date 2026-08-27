"use client";

import AddIcon from "@mui/icons-material/Add";
import LocalTaxiIcon from "@mui/icons-material/LocalTaxi";
import RemoveIcon from "@mui/icons-material/Remove";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { RideProviderInfo, RideQuoteRequest } from "@openmapx/core";
import {
  buildRideOpenUrl,
  formatDistance,
  formatDuration,
  isQuoteExpired,
  useDirectionsStore,
  useRideProviders,
  useRideQuotes,
  useRideStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { RideQuoteList } from "@/components/panels/directions/RideQuoteList";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { BRAND } from "@/lib/theme";

/** Stop refreshing quotes once the user has stopped interacting with the panel. */
const IDLE_MS = 5 * 60 * 1000;

const inputSx = {
  border: "1px solid",
  borderColor: "divider",
  borderRadius: "8px",
  px: 1.5,
  py: 0.75,
  fontSize: "0.875rem",
  fontFamily: "inherit",
  color: "text.primary",
  bgcolor: "background.paper",
  outline: "none",
  "&:focus": { borderColor: BRAND },
  width: "100%",
  boxSizing: "border-box",
} as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{
        fontWeight: 600,
        color: "text.secondary",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </Typography>
  );
}

function ProviderChip({
  provider,
  selected,
  onSelect,
}: {
  provider: RideProviderInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      onClick={onSelect}
      sx={{
        px: 1.5,
        py: 0.5,
        borderRadius: 99,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid",
        borderColor: selected ? BRAND : "divider",
        bgcolor: selected ? `${BRAND}18` : "background.paper",
        "&:hover": { borderColor: BRAND },
        transition: "border-color 0.15s",
      }}
    >
      <Typography
        variant="caption"
        sx={{ fontWeight: 500 }}
        color={selected ? BRAND : "text.primary"}
      >
        {provider.name}
      </Typography>
    </Box>
  );
}

function PaxStepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const btnSx = {
    border: "1px solid",
    borderColor: "divider",
    bgcolor: "background.paper",
    borderRadius: "50%",
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: "text.primary",
    "&:hover": { borderColor: BRAND, color: BRAND },
    "&:disabled": { opacity: 0.4, cursor: "default" },
  } as const;
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <Typography variant="body2">{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          component="button"
          type="button"
          aria-label={`-${label}`}
          disabled={value <= 1}
          onClick={() => onChange(value - 1)}
          sx={btnSx}
        >
          <RemoveIcon sx={{ fontSize: 16 }} />
        </Box>
        <Typography variant="body2" sx={{ minWidth: 16, textAlign: "center", fontWeight: 600 }}>
          {value}
        </Typography>
        <Box
          component="button"
          type="button"
          aria-label={`+${label}`}
          disabled={value >= 8}
          onClick={() => onChange(value + 1)}
          sx={btnSx}
        >
          <AddIcon sx={{ fontSize: 16 }} />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Ride directions surface. The route itself is drawn by the normal driving
 * query the directions panel already runs; this panel adds provider selection,
 * quotes and the handoff. Only one provider's detail is shown at a time unless
 * the operator has unlocked comparison — several ride-hailing providers' terms
 * forbid presenting them alongside competitors.
 */
export function RidePanel({ route }: { route?: RideQuoteRequest["route"] }) {
  const t = useTranslations("directions");
  const locale = useLocale();
  const origin = useDirectionsStore((s) => s.waypoints[0]?.coords ?? null);
  const destination = useDirectionsStore((s) => s.waypoints.at(-1)?.coords ?? null);

  const providerId = useRideStore((s) => s.providerId);
  const setProvider = useRideStore((s) => s.setProvider);
  const passengers = useRideStore((s) => s.passengers);
  const setPassengers = useRideStore((s) => s.setPassengers);
  const pickupAt = useRideStore((s) => s.pickupAt);
  const setPickupAt = useRideStore((s) => s.setPickupAt);
  const reset = useRideStore((s) => s.reset);

  const { data, isLoading } = useRideProviders(origin, destination);
  const providers = useMemo(() => data?.providers ?? [], [data]);
  const selected = providers.find((p) => p.id === providerId) ?? null;
  const defaultProvider = data?.defaultProvider;
  const comparison = data?.comparison;

  // Quotes only refresh while the panel can actually be seen and the user is
  // still around: a background tab or an abandoned panel must not keep asking a
  // provider to price a trip nobody is looking at.
  const [lastInteraction, setLastInteraction] = useState(() => Date.now());
  const [visible, setVisible] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const touch = useCallback(() => setLastInteraction(Date.now()), []);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Default to the backend-configured provider once the list arrives.
  useEffect(() => {
    if (!providerId && defaultProvider) setProvider(defaultProvider);
  }, [providerId, defaultProvider, setProvider]);

  // Drop the selection when the panel goes away so a stale provider does not
  // survive into the next trip.
  useEffect(() => () => reset(), [reset]);

  const comparing =
    (comparison?.allowed ?? false) && (comparison?.comparableProviderIds.length ?? 0) >= 2;
  const quoteProviderIds = comparing
    ? (comparison?.comparableProviderIds ?? [])
    : selected?.capabilities.quote
      ? [selected.id]
      : [];

  const quoteRequest: RideQuoteRequest | null = origin
    ? {
        pickup: origin,
        dropoff: destination ?? undefined,
        passengers,
        pickupAt: pickupAt ?? undefined,
        route,
      }
    : null;

  const quotesEnabled = visible && now - lastInteraction < IDLE_MS;
  const { results, expiresAt, refetch } = useRideQuotes({
    request: quoteRequest,
    providerIds: quoteProviderIds,
    enabled: quotesEnabled,
  });

  // Uses the canonical rule rather than comparing the timestamp inline: an
  // unparseable expiry counts as already expired, where `now >= Date.parse(...)`
  // would be false for NaN and leave a stale price on screen indefinitely.
  const nowDate = useMemo(() => new Date(now), [now]);
  const allQuotes = useMemo(() => results.flatMap((r) => r.quotes), [results]);
  const expired = allQuotes.length > 0 && allQuotes.some((q) => isQuoteExpired(q, nowDate));

  // Refresh the moment a quote lapses, so long as the panel is still being
  // watched. Without this a price simply dies after a minute and Book stays
  // disabled until someone notices the Refresh link.
  useEffect(() => {
    if (expired && quotesEnabled) void refetch();
  }, [expired, quotesEnabled, refetch]);
  const secondsLeft =
    expiresAt === null ? null : Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));

  const openProvider = (id: string, productId?: string) => {
    if (!origin) return;
    touch();
    const url = buildRideOpenUrl(id, {
      pickup: origin,
      dropoff: destination ?? undefined,
      passengers,
      pickupAt: pickupAt ?? undefined,
      productId,
      route,
    });
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (!origin || !destination) {
    return (
      <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
        <Typography variant="body2" color="text.secondary">
          {t("chooseRidePoints")}
        </Typography>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Box sx={{ px: 2, py: 3, display: "flex", justifyContent: "center" }}>
        <CircularProgress size={18} sx={{ color: "text.disabled" }} />
      </Box>
    );
  }

  if (providers.length === 0) {
    return (
      <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
        <Typography variant="body2" color="text.secondary">
          {t("rideNoProviders")}
        </Typography>
      </Box>
    );
  }

  const bookingRules = selected?.availability.bookingRules;
  const allowsPrebook = bookingRules !== undefined && bookingRules.bookingType !== 0;
  // Providers excluded from a comparison list keep their own chip below it.
  const chipProviders = comparing
    ? providers.filter((p) => !comparison?.comparableProviderIds.includes(p.id))
    : providers;
  // While comparing, the list above already covers the comparable providers,
  // so the detail block below belongs to the chip row only — otherwise the
  // auto-selected default could render a second CTA for a provider already
  // shown in the list.
  const detailProvider = comparing
    ? (chipProviders.find((p) => p.id === selected?.id) ?? null)
    : selected;
  // Whoever supplied the numbers gets credited beside them.
  const detailAttributions =
    results.find((r) => r.providerId === detailProvider?.id)?.attributions ?? [];

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.75 }}>
      {route && (
        <Typography variant="caption" sx={{ color: BRAND, fontWeight: 600 }}>
          {t("rideTripSummary", {
            distance: formatDistance(route.distanceMeters),
            duration: formatDuration(route.durationSeconds),
          })}
        </Typography>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        {t("rideDisclaimer")}
      </Typography>

      {comparing && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          {results.map((result) => {
            const provider = providers.find((p) => p.id === result.providerId);
            if (!provider) return null;
            return (
              <Box
                key={result.providerId}
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <SectionLabel>{provider.name}</SectionLabel>
                <RideQuoteList
                  providerName={provider.name}
                  quotes={result.quotes}
                  expired={expired}
                  locale={locale}
                  onBook={(productId) => openProvider(result.providerId, productId)}
                />
                {result.attributions.length > 0 && (
                  <AttributionStrip attributions={result.attributions} variant="inline" />
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {chipProviders.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          <SectionLabel>{t("rideProvider")}</SectionLabel>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
            {chipProviders.map((p) => (
              <ProviderChip
                key={p.id}
                provider={p}
                selected={p.id === selected?.id}
                onSelect={() => {
                  touch();
                  setProvider(p.id);
                }}
              />
            ))}
          </Box>
        </Box>
      )}

      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <SectionLabel>{t("ridePassengers")}</SectionLabel>
        <PaxStepper
          label={t("ridePassengers")}
          value={passengers}
          onChange={(v) => {
            touch();
            setPassengers(v);
          }}
        />
      </Box>

      {allowsPrebook && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <SectionLabel>{t("ridePickupTime")}</SectionLabel>
          <Box
            component="input"
            type="datetime-local"
            value={pickupAt ?? ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              touch();
              setPickupAt(e.target.value || null);
            }}
            sx={inputSx}
          />
          {bookingRules?.priorNoticeMinutesMin !== undefined && (
            <Typography variant="caption" color="text.secondary">
              {t("ridePrebookNotice", { minutes: bookingRules.priorNoticeMinutesMin })}
            </Typography>
          )}
        </Box>
      )}

      {detailProvider && (
        <>
          {!detailProvider.availability.coverageChecked && (
            <Typography variant="caption" color="text.secondary">
              {t("rideCoverageUnknown", { provider: detailProvider.name })}
            </Typography>
          )}

          {!detailProvider.handoffCarriesCoordinates && (
            <Typography variant="caption" color="text.secondary">
              {t("rideNoCoordinates", { provider: detailProvider.name })}
            </Typography>
          )}

          {detailProvider.capabilities.quote ? (
            <>
              <RideQuoteList
                providerName={detailProvider.name}
                quotes={results.find((r) => r.providerId === detailProvider.id)?.quotes ?? []}
                expired={expired}
                locale={locale}
                onBook={(productId) => openProvider(detailProvider.id, productId)}
              />
              {detailAttributions.length > 0 && (
                <AttributionStrip attributions={detailAttributions} variant="inline" />
              )}
            </>
          ) : (
            <Box
              component="button"
              type="button"
              onClick={() => openProvider(detailProvider.id)}
              sx={{
                mt: 0.5,
                width: "100%",
                border: "none",
                borderRadius: "10px",
                py: 1.25,
                bgcolor: BRAND,
                color: "#fff",
                fontSize: "0.9rem",
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
                transition: "opacity 0.15s",
                "&:hover": { opacity: 0.9 },
              }}
            >
              <LocalTaxiIcon sx={{ fontSize: 18 }} />
              {t("rideOpenIn", { provider: detailProvider.name })}
            </Box>
          )}
        </>
      )}

      {expiresAt !== null &&
        (expired ? (
          <Box
            component="button"
            type="button"
            onClick={() => {
              touch();
              void refetch();
            }}
            sx={{
              alignSelf: "flex-start",
              border: 0,
              bgcolor: "transparent",
              color: BRAND,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "0.8rem",
              fontWeight: 600,
              px: 0,
            }}
          >
            {t("rideRefreshQuotes")}
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {t("rideQuoteExpiresIn", { seconds: secondsLeft ?? 0 })}
          </Typography>
        ))}
    </Box>
  );
}
