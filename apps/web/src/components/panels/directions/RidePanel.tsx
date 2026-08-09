"use client";

import LocalTaxiIcon from "@mui/icons-material/LocalTaxi";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { RideProviderInfo } from "@openmapx/core";
import {
  buildRideOpenUrl,
  useDirectionsStore,
  useRideProviders,
  useRideStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { BRAND } from "@/lib/theme";

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

/**
 * Ride directions surface. The route itself is drawn by the normal driving
 * query the directions panel already runs; this panel adds provider selection
 * and the handoff. Only one provider's detail is shown at a time — several
 * ride-hailing providers' terms forbid presenting them alongside competitors.
 */
export function RidePanel() {
  const t = useTranslations("directions");
  const origin = useDirectionsStore((s) => s.origin);
  const destination = useDirectionsStore((s) => s.destination);

  const providerId = useRideStore((s) => s.providerId);
  const setProvider = useRideStore((s) => s.setProvider);
  const passengers = useRideStore((s) => s.passengers);
  const reset = useRideStore((s) => s.reset);

  const { data, isLoading } = useRideProviders(origin, destination);
  const providers = data?.providers ?? [];
  const selected = providers.find((p) => p.id === providerId) ?? null;
  const defaultProvider = data?.defaultProvider;

  // Default to the backend-configured provider once the list arrives.
  useEffect(() => {
    if (!providerId && defaultProvider) setProvider(defaultProvider);
  }, [providerId, defaultProvider, setProvider]);

  // Drop the selection when the panel goes away so a stale provider does not
  // survive into the next trip.
  useEffect(() => () => reset(), [reset]);

  const handleOpen = () => {
    if (!selected || !origin) return;
    const url = buildRideOpenUrl(selected.id, {
      pickup: origin,
      dropoff: destination ?? undefined,
      passengers,
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

  return (
    <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        {t("rideDisclaimer")}
      </Typography>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Typography
          variant="caption"
          sx={{
            fontWeight: 600,
            color: "text.secondary",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {t("rideProvider")}
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {providers.map((p) => (
            <ProviderChip
              key={p.id}
              provider={p}
              selected={p.id === selected?.id}
              onSelect={() => setProvider(p.id)}
            />
          ))}
        </Box>
      </Box>

      {selected && (
        <>
          {!selected.availability.coverageChecked && (
            <Typography variant="caption" color="text.secondary">
              {t("rideCoverageUnknown", { provider: selected.name })}
            </Typography>
          )}

          <Box
            component="button"
            type="button"
            onClick={handleOpen}
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
            {t("rideOpenIn", { provider: selected.name })}
          </Box>
        </>
      )}
    </Box>
  );
}
