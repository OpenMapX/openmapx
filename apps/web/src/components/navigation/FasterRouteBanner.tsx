"use client";

import AltRouteIcon from "@mui/icons-material/AltRoute";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { formatDuration, useNavigationStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { haptics } from "@/lib/haptics";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";

/** Seconds the offer stands before it is taken automatically. */
const AUTO_ACCEPT_SECONDS = 10;

/**
 * Offers a faster route found mid-drive and takes it unless the driver
 * declines. Auto-accepting is the default because the driver this exists for is
 * the one who cannot safely reach for the screen; declining is one tap and buys
 * ten minutes of quiet.
 */
export function FasterRouteBanner() {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const proposal = useNavigationStore((s) => s.fasterRoute);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const accept = useNavigationStore((s) => s.acceptFasterRoute);
  const dismiss = useNavigationStore((s) => s.dismissFasterRoute);
  const [remaining, setRemaining] = useState(AUTO_ACCEPT_SECONDS);
  const announcedRef = useRef<number | null>(null);

  const savedText = proposal ? formatDuration(proposal.savedSeconds) : "";

  useEffect(() => {
    if (!proposal) {
      announcedRef.current = null;
      return;
    }
    if (announcedRef.current === proposal.proposedAtMs) return;
    announcedRef.current = proposal.proposedAtMs;
    haptics.warn();
    if (voiceEnabled) speak(t("fasterRouteAnnounce", { saving: savedText }));
  }, [proposal, voiceEnabled, speak, t, savedText]);

  // Count down against a fixed deadline rather than decrementing per tick, and
  // accept from the interval body rather than from inside a state updater.
  // Updater functions must be pure — React invokes them more than once in
  // development — and a wall-clock deadline also survives the interval being
  // throttled while the tab is backgrounded, where decrementing would stall.
  useEffect(() => {
    if (!proposal) return;
    const deadline = proposal.proposedAtMs + AUTO_ACCEPT_SECONDS * 1000;
    const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setRemaining(secondsLeft());
    const tick = setInterval(() => {
      const left = secondsLeft();
      setRemaining(left);
      if (left <= 0) {
        clearInterval(tick);
        accept();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [proposal, accept]);

  if (!proposal) return null;

  return (
    <Box
      data-testid="faster-route-banner"
      role="status"
      aria-live="polite"
      sx={{
        alignSelf: "flex-start",
        bgcolor: "background.paper",
        borderRadius: 2,
        px: 1.5,
        py: 1,
        display: "flex",
        alignItems: "center",
        gap: 1,
        boxShadow: 2,
      }}
    >
      <AltRouteIcon fontSize="small" color="success" />
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {t("fasterRouteTitle")} · {t("fasterRouteSaving", { saving: savedText })}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {proposal.route.summary
            ? `${t("fasterRouteVia", { road: proposal.route.summary })} · `
            : ""}
          {t("fasterRouteCountdown", { seconds: remaining })}
        </Typography>
      </Box>
      <Button data-testid="faster-route-dismiss" size="small" onClick={dismiss}>
        {t("fasterRouteDismiss")}
      </Button>
      <Button data-testid="faster-route-accept" size="small" variant="contained" onClick={accept}>
        {t("fasterRouteAccept")}
      </Button>
    </Box>
  );
}
