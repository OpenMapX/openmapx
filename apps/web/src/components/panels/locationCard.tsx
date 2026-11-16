"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTranslations } from "next-intl";
import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { useMapFooterBox } from "@/lib/mapFooterCenter";
import { subscribeMobileFooterSurfaces, topMobileFooterSurface } from "@/lib/mobileFooterSurface";

/**
 * The floating card for a point on the map (a dropped pin, the location dot):
 * a heading with its own close button, then a row of actions. Shared so every
 * such card sits in the same place and reads the same way.
 */

const CARD_GAP = 8;

function sheetTop(): number | null {
  const surface = topMobileFooterSurface();
  return surface ? surface.bottom - surface.visibleHeight : null;
}

/**
 * Where the phone card rests: above an open sheet, or above the map footer —
 * never over the map credits, which have to stay readable.
 */
function usePhoneCardBottom(): string {
  const footer = useMapFooterBox();
  const top = useSyncExternalStore(subscribeMobileFooterSurfaces, sheetTop, () => null);
  if (top !== null) return `${Math.max(0, window.innerHeight - top) + CARD_GAP}px`;
  return `calc(var(--omx-map-footer-bottom, var(--omx-safe-bottom)) + ${footer.height + CARD_GAP}px)`;
}

export function LocationCard({
  ariaLabel,
  icon,
  heading,
  onClose,
  actions,
}: {
  ariaLabel: string;
  icon: ReactNode;
  /** The title and what follows it (address, coordinates). */
  heading: ReactNode;
  onClose: () => void;
  /** {@link LocationCardAction}s, the first usually `primary`. */
  actions: ReactNode;
}) {
  const tc = useTranslations("common");
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const phoneCardBottom = usePhoneCardBottom();
  return (
    <Paper
      elevation={3}
      role="region"
      aria-label={ariaLabel}
      sx={{
        position: "absolute",
        zIndex: 11,
        borderRadius: 3,
        overflow: "hidden",
        ...(isMobile
          ? { left: CARD_GAP, right: CARD_GAP, bottom: phoneCardBottom }
          : {
              bottom: 24,
              left: "50%",
              transform: "translateX(-50%)",
              width: "min(480px, calc(100% - 32px))",
            }),
      }}
    >
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 2, pt: 1.5 }}>
        <Box sx={{ display: "flex", color: "text.secondary", mt: 0.25, "& svg": { fontSize: 22 } }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>{heading}</Box>
        <IconButton
          onClick={onClose}
          aria-label={tc("close")}
          sx={{ width: 44, height: 44, mr: -1.5, mt: -1 }}
        >
          <CloseIcon />
        </IconButton>
      </Box>
      <Box
        sx={{
          display: "flex",
          gap: 1,
          px: 2,
          pt: 1.5,
          pb: 1.5,
          // A phone scrolls the row under the thumb; wider screens have
          // the room to show every action at once.
          ...(isMobile
            ? {
                overflowX: "auto",
                scrollbarWidth: "none",
                "&::-webkit-scrollbar": { display: "none" },
              }
            : { flexWrap: "wrap" }),
        }}
      >
        {actions}
      </Box>
    </Paper>
  );
}

export function LocationCardAction({
  icon,
  label,
  onClick,
  primary,
  disabled,
  menuOpen,
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  primary?: boolean;
  disabled?: boolean;
  /** Set on a button that opens a menu: whether that menu is open. */
  menuOpen?: boolean;
}) {
  return (
    <Button
      variant={primary ? "contained" : "outlined"}
      startIcon={icon}
      onClick={onClick}
      disabled={disabled}
      {...(menuOpen !== undefined && {
        "aria-haspopup": "menu" as const,
        "aria-expanded": menuOpen,
      })}
      sx={{
        flexShrink: 0,
        minHeight: 40,
        borderRadius: 999,
        textTransform: "none",
        whiteSpace: "nowrap",
        ...(primary
          ? { bgcolor: BRAND, "&:hover": { bgcolor: "var(--omx-brand-hover)" } }
          : { color: "text.primary", borderColor: "divider" }),
      }}
    >
      {label}
    </Button>
  );
}
