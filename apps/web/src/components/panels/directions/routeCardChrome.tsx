"use client";

import NavigationIcon from "@mui/icons-material/Navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { MouseEvent, ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import type { StartFailure } from "@/lib/mobile/useStartNavigation";

/**
 * The frame of one offered route, shared by the driving and transit lists: a
 * brand bar and a light brand tint mark the chosen one.
 */
export function routeCardFrameSx(active: boolean) {
  return {
    px: 2,
    py: 1.5,
    cursor: "pointer",
    borderLeft: active ? `4px solid ${BRAND}` : "4px solid transparent",
    bgcolor: active ? "color-mix(in srgb, var(--omx-brand) 5%, transparent)" : "transparent",
    "&:hover": {
      bgcolor: active ? "color-mix(in srgb, var(--omx-brand) 8%, transparent)" : "action.hover",
    },
    transition: "background-color 0.15s",
  } as const;
}

/** Primary Start button shared by route cards, summaries, and details views. */
export function RouteStartButton({
  onClick,
  disabled,
}: {
  onClick: (event: MouseEvent) => void;
  disabled?: boolean;
}) {
  const tNav = useTranslations("navigation");
  return (
    <Button
      size="small"
      variant="contained"
      startIcon={<NavigationIcon />}
      disabled={disabled}
      onClick={onClick}
    >
      {tNav("start")}
    </Button>
  );
}

/** Error feedback below a ground-navigation Start action. */
export function RouteStartError({ error }: { error: StartFailure | null | undefined }) {
  const tNav = useTranslations("navigation");
  if (!error) return null;
  return (
    <Typography role="alert" sx={{ fontSize: 12, color: "error.main", mt: 0.5 }}>
      {tNav(error === "incompatible" ? "startUpdateRequired" : "startFailed")}
    </Typography>
  );
}

/**
 * Whether a pointer click inside a route card landed on an interactive control
 * or the action row itself (including a disabled MUI button, whose
 * `pointer-events: none` sends the event to the row wrapper).
 */
export function isInteractiveCardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, input, label, a, [role='button'], [data-route-actions]"))
  );
}

/** The chosen route's actions: Details, and Start where the mode can be navigated. */
export function RouteCardActions({
  onDetails,
  onStart,
  startDisabled,
  children,
}: {
  onDetails: () => void;
  /** Omitted for modes without turn-by-turn guidance. */
  onStart?: () => void;
  startDisabled?: boolean;
  /** Follows the buttons, e.g. a start error. */
  children?: ReactNode;
}) {
  const tc = useTranslations("common");
  // The card selects itself on click; its own buttons must not.
  const stop = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };
  return (
    <Box data-route-actions="" sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1 }}>
      <Button size="small" variant="tonal" onClick={stop(onDetails)}>
        {tc("details")}
      </Button>
      {onStart && <RouteStartButton disabled={startDisabled} onClick={stop(onStart)} />}
      {children}
    </Box>
  );
}
