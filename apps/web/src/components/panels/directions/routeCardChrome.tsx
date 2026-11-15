"use client";

import NavigationIcon from "@mui/icons-material/Navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useTranslations } from "next-intl";
import type { MouseEvent, ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

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
  const tNav = useTranslations("navigation");
  // The card selects itself on click; its own buttons must not.
  const stop = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };
  return (
    <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1 }}>
      <Button size="small" variant="tonal" onClick={stop(onDetails)}>
        {tc("details")}
      </Button>
      {onStart && (
        <Button
          size="small"
          variant="contained"
          startIcon={<NavigationIcon />}
          disabled={startDisabled}
          onClick={stop(onStart)}
        >
          {tNav("start")}
        </Button>
      )}
      {children}
    </Box>
  );
}
