"use client";

import AddIcon from "@mui/icons-material/Add";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import EditIcon from "@mui/icons-material/Edit";
import FlightTakeoffIcon from "@mui/icons-material/FlightTakeoff";
import RemoveIcon from "@mui/icons-material/Remove";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type {
  AirportSearchHit,
  CabinClass,
  FlightEndpoint,
  FlightProviderInfo,
  FlightSearchParams,
} from "@openmapx/core";
import {
  buildFlightOpenUrl,
  estimateFlightMinutes,
  formatDuration,
  haversineDistance,
  useAirportSearch,
  useDebounce,
  useDirectionsStore,
  useFlightProviders,
  useFlightStore,
  useNearestAirports,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type ChangeEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

type T = ReturnType<typeof useTranslations>;

const CABINS: { value: CabinClass; labelKey: string }[] = [
  { value: "economy", labelKey: "cabinEconomy" },
  { value: "premiumeconomy", labelKey: "cabinPremiumEconomy" },
  { value: "business", labelKey: "cabinBusiness" },
  { value: "first", labelKey: "cabinFirst" },
];

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function hitToEndpoint(hit: AirportSearchHit): FlightEndpoint | null {
  if (!hit.iata) return null;
  return { iata: hit.iata, name: hit.name, coordinates: [hit.lng, hit.lat] };
}

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

/** Inline airport picker: shows the resolved airport with a "change" action,
 *  or an autocomplete input when editing / unresolved. */
function AirportField({
  icon,
  label,
  value,
  loading,
  onChange,
  t,
}: {
  icon: ReactNode;
  label: string;
  value: FlightEndpoint | null;
  loading: boolean;
  onChange: (e: FlightEndpoint) => void;
  t: T;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 250);
  const { data } = useAirportSearch(debounced);
  const matches = (data?.matches ?? []).filter((m) => m.iata);

  const showInput = editing || (!value && !loading);

  return (
    <Box sx={{ position: "relative" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ color: "text.secondary", display: "flex" }}>{icon}</Box>
        {showInput ? (
          <Box
            component="input"
            autoFocus
            placeholder={`${label} — ${t("searchAirport")}`}
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            onBlur={() => setTimeout(() => setEditing(false), 150)}
            sx={inputSx}
          />
        ) : loading ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.75 }}>
            <CircularProgress size={14} sx={{ color: "text.disabled" }} />
            <Typography variant="body2" color="text.secondary">
              {t("nearestAirport")}…
            </Typography>
          </Box>
        ) : value ? (
          <Box
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 1,
              minWidth: 0,
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                {value.iata}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {value.name}
              </Typography>
            </Box>
            <Box
              component="button"
              type="button"
              aria-label={t("changeAirport")}
              onClick={() => {
                setQuery("");
                setEditing(true);
              }}
              sx={{
                border: "none",
                bgcolor: "transparent",
                color: BRAND,
                cursor: "pointer",
                display: "flex",
                p: 0.5,
                borderRadius: 1,
                "&:hover": { bgcolor: `${BRAND}18` },
              }}
            >
              <EditIcon sx={{ fontSize: 16 }} />
            </Box>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ py: 0.75 }}>
            {t("noAirportNearby")}
          </Typography>
        )}
      </Box>

      {showInput && matches.length > 0 && (
        <Box
          sx={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            mt: 0.5,
            zIndex: 5,
            bgcolor: "background.paper",
            borderRadius: "8px",
            boxShadow: "0 4px 12px var(--omx-shadow-soft)",
            overflow: "hidden",
          }}
        >
          {matches.slice(0, 6).map((m) => (
            <Box
              key={m.id}
              onMouseDown={() => {
                const ep = hitToEndpoint(m);
                if (ep) onChange(ep);
                setEditing(false);
                setQuery("");
              }}
              sx={{
                px: 1.5,
                py: 1,
                cursor: "pointer",
                display: "flex",
                alignItems: "baseline",
                gap: 1,
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 34 }}>
                {m.iata}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {m.name}
                {m.municipality ? ` · ${m.municipality}` : ""}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function PaxStepper({
  label,
  value,
  min,
  onChange,
  dim,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
  dim?: boolean;
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
    "&:disabled": {
      opacity: 0.4,
      cursor: "default",
      "&:hover": { borderColor: "divider", color: "text.primary" },
    },
  } as const;
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        opacity: dim ? 0.5 : 1,
      }}
    >
      <Typography variant="body2">{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          component="button"
          type="button"
          aria-label={`-${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
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
          disabled={value >= 9}
          onClick={() => onChange(Math.min(9, value + 1))}
          sx={btnSx}
        >
          <AddIcon sx={{ fontSize: 16 }} />
        </Box>
      </Box>
    </Box>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
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

/**
 * Flight directions surface. Resolves nearest airports for the directions
 * origin/destination, lets the user adjust airports, dates, passengers, cabin
 * and direct-only, pick a search engine, then opens a pre-filled search on that
 * engine. No live flight data is fetched.
 */
export function FlightPanel() {
  const t = useTranslations("directions");
  const origin = useDirectionsStore((s) => s.waypoints[0]?.coords ?? null);
  const destination = useDirectionsStore((s) => s.waypoints.at(-1)?.coords ?? null);
  const setFlightEndpoints = useFlightStore((s) => s.setEndpoints);
  const clearFlightEndpoints = useFlightStore((s) => s.clear);
  const cabinSelectId = useId();

  const [fromAirport, setFromAirport] = useState<FlightEndpoint | null>(null);
  const [toAirport, setToAirport] = useState<FlightEndpoint | null>(null);

  const [roundTrip, setRoundTrip] = useState(true);
  const [departDate, setDepartDate] = useState(() => ymd(addDays(new Date(), 7)));
  const [returnDate, setReturnDate] = useState(() => ymd(addDays(new Date(), 14)));
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);
  const [cabin, setCabin] = useState<CabinClass>("economy");
  const [directOnly, setDirectOnly] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);

  const todayStr = useMemo(() => ymd(new Date()), []);

  const nearestFrom = useNearestAirports(origin);
  const nearestTo = useNearestAirports(destination);
  const providersQuery = useFlightProviders();
  const providers: FlightProviderInfo[] = providersQuery.data?.providers ?? [];
  const provider = providers.find((p) => p.id === providerId);
  const caps = provider?.capabilities;
  const supports = (key: keyof NonNullable<typeof caps>) => !caps || caps[key];

  // Fields the selected provider's deep link can't encode, so they won't carry
  // over to the opened search. Collapse the three passenger counts into a single
  // "passengers" entry when none of them are supported (e.g. Kiwi, Skiplagged).
  const ignoredFields: string[] = [];
  if (caps) {
    if (!caps.adults && !caps.children && !caps.infants) {
      ignoredFields.push(t("passengers"));
    } else {
      if (!caps.adults) ignoredFields.push(t("adults"));
      if (!caps.children) ignoredFields.push(t("childrenPax"));
      if (!caps.infants) ignoredFields.push(t("infants"));
    }
    if (!caps.cabin) ignoredFields.push(t("cabin"));
    if (!caps.directOnly) ignoredFields.push(t("directOnly"));
  }

  // Reset the chosen airport when the underlying directions point changes, so a
  // fresh nearest-airport prefill kicks in.
  const originKey = origin ? `${origin[0]},${origin[1]}` : "";
  const destKey = destination ? `${destination[0]},${destination[1]}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on coords
  useEffect(() => setFromAirport(null), [originKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on coords
  useEffect(() => setToAirport(null), [destKey]);

  // Prefill from the nearest scheduled-service airport once resolved.
  useEffect(() => {
    if (!fromAirport && nearestFrom.data?.matches?.[0]) {
      const ep = hitToEndpoint(nearestFrom.data.matches[0]);
      if (ep) setFromAirport(ep);
    }
  }, [fromAirport, nearestFrom.data]);
  useEffect(() => {
    if (!toAirport && nearestTo.data?.matches?.[0]) {
      const ep = hitToEndpoint(nearestTo.data.matches[0]);
      if (ep) setToAirport(ep);
    }
  }, [toAirport, nearestTo.data]);

  // Default the provider to the backend-configured default.
  useEffect(() => {
    if (!providerId && providersQuery.data) setProviderId(providersQuery.data.defaultProvider);
  }, [providerId, providersQuery.data]);

  const handleRoundTripChange = (next: boolean) => {
    setRoundTrip(next);
    if (next && returnDate < departDate) setReturnDate(departDate);
  };

  const handleDepartDateChange = (next: string) => {
    setDepartDate(next);
    if (roundTrip && returnDate < next) setReturnDate(next);
  };

  const handleReturnDateChange = (next: string) => {
    setReturnDate(next < departDate ? departDate : next);
  };

  // Publish resolved airports to the map arc layer; clear on unmount.
  useEffect(() => {
    setFlightEndpoints(fromAirport, toAirport);
  }, [fromAirport, toAirport, setFlightEndpoints]);
  useEffect(() => () => clearFlightEndpoints(), [clearFlightEndpoints]);

  const distanceKm = useMemo(() => {
    if (!fromAirport || !toAirport) return null;
    return haversineDistance(fromAirport.coordinates, toAirport.coordinates) / 1000;
  }, [fromAirport, toAirport]);
  const estMinutes = distanceKm !== null ? estimateFlightMinutes(distanceKm) : null;

  const canSearch =
    !!fromAirport &&
    !!toAirport &&
    !!providerId &&
    !!departDate &&
    (!roundTrip || !!returnDate) &&
    fromAirport.iata !== toAirport.iata;

  const handleSearch = () => {
    if (!canSearch || !providerId || !fromAirport || !toAirport) return;
    const params: FlightSearchParams = {
      from: fromAirport.iata,
      to: toAirport.iata,
      departDate,
      returnDate: roundTrip ? returnDate : undefined,
      adults,
      children,
      infants,
      cabin,
      directOnly,
    };
    window.open(buildFlightOpenUrl(providerId, params), "_blank", "noopener,noreferrer");
  };

  if (!origin || !destination) {
    return (
      <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
        <Typography variant="body2" color="text.secondary">
          {t("chooseFlightPoints")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        {t("flightDisclaimer")}
      </Typography>

      {/* Airports */}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <AirportField
          icon={<FlightTakeoffIcon sx={{ fontSize: 18 }} />}
          label={t("flightFrom")}
          value={fromAirport}
          loading={nearestFrom.isLoading && !fromAirport}
          onChange={setFromAirport}
          t={t}
        />
        <AirportField
          icon={<FlightTakeoffIcon sx={{ fontSize: 18, transform: "scaleX(-1)" }} />}
          label={t("flightTo")}
          value={toAirport}
          loading={nearestTo.isLoading && !toAirport}
          onChange={setToAirport}
          t={t}
        />
      </Box>

      {estMinutes !== null && (
        <Typography variant="caption" sx={{ color: BRAND, fontWeight: 600 }}>
          {t("estFlightTime", { duration: formatDuration(estMinutes * 60) })}
        </Typography>
      )}

      {/* Trip type */}
      <Box sx={{ display: "flex", gap: 0.5 }}>
        {(
          [
            ["roundTrip", true],
            ["oneWay", false],
          ] as const
        ).map(([key, val]) => (
          <Box
            key={key}
            onClick={() => handleRoundTripChange(val)}
            sx={{
              px: 1.5,
              py: 0.5,
              borderRadius: 99,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid",
              borderColor: roundTrip === val ? BRAND : "divider",
              bgcolor: roundTrip === val ? `${BRAND}18` : "background.paper",
              "&:hover": { borderColor: BRAND },
              transition: "border-color 0.15s",
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontWeight: 500 }}
              color={roundTrip === val ? BRAND : "text.primary"}
            >
              {t(key)}
            </Typography>
          </Box>
        ))}
      </Box>

      {/* Dates */}
      <Box sx={{ display: "flex", gap: 1 }}>
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <SectionLabel>{t("departDate")}</SectionLabel>
          <Box
            component="input"
            type="date"
            min={todayStr}
            value={departDate}
            onChange={(e: ChangeEvent<HTMLInputElement>) => handleDepartDateChange(e.target.value)}
            sx={inputSx}
          />
        </Box>
        {roundTrip && (
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
            <SectionLabel>{t("returnDateLabel")}</SectionLabel>
            <Box
              component="input"
              type="date"
              min={departDate || todayStr}
              value={returnDate}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                handleReturnDateChange(e.target.value)
              }
              sx={inputSx}
            />
          </Box>
        )}
      </Box>

      {/* Passengers */}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <SectionLabel>{t("passengers")}</SectionLabel>
        <PaxStepper
          label={t("adults")}
          value={adults}
          min={1}
          onChange={setAdults}
          dim={!supports("adults")}
        />
        <PaxStepper
          label={t("childrenPax")}
          value={children}
          min={0}
          onChange={setChildren}
          dim={!supports("children")}
        />
        <PaxStepper
          label={t("infants")}
          value={infants}
          min={0}
          onChange={setInfants}
          dim={!supports("infants")}
        />
      </Box>

      {/* Cabin */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 0.5,
          opacity: supports("cabin") ? 1 : 0.5,
        }}
      >
        <SectionLabel>{t("cabin")}</SectionLabel>
        <Box
          component="select"
          id={cabinSelectId}
          value={cabin}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setCabin(e.target.value as CabinClass)}
          sx={inputSx}
        >
          {CABINS.map((c) => (
            <option key={c.value} value={c.value}>
              {t(c.labelKey)}
            </option>
          ))}
        </Box>
      </Box>

      {/* Direct only */}
      <Box
        onClick={() => setDirectOnly((v) => !v)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          opacity: supports("directOnly") ? 1 : 0.5,
          "&:hover": { color: BRAND },
        }}
      >
        {directOnly ? (
          <CheckBoxIcon sx={{ fontSize: 20, color: BRAND }} />
        ) : (
          <CheckBoxOutlineBlankIcon sx={{ fontSize: 20, color: "text.secondary" }} />
        )}
        <Typography variant="body2">{t("directOnly")}</Typography>
      </Box>

      {/* Provider selector */}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <SectionLabel>{t("flightProvider")}</SectionLabel>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {providers.map((p) => {
            const selected = p.id === providerId;
            return (
              <Box
                key={p.id}
                onClick={() => setProviderId(p.id)}
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
                  {p.name}
                </Typography>
              </Box>
            );
          })}
        </Box>
        {ignoredFields.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {t("flightIgnores", {
              provider: provider?.name ?? "",
              fields: ignoredFields.join(", "),
            })}
          </Typography>
        )}
      </Box>

      {/* Search */}
      <Box
        component="button"
        type="button"
        disabled={!canSearch}
        onClick={handleSearch}
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
          "&:disabled": { opacity: 0.4, cursor: "default" },
        }}
      >
        <FlightTakeoffIcon sx={{ fontSize: 18 }} />
        {t("searchFlights")}
      </Box>
    </Box>
  );
}
