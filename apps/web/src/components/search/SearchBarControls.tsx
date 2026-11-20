"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import MenuIcon from "@mui/icons-material/Menu";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import {
  PANEL,
  useActiveSidePanel,
  useDirectionsStore,
  useMenuStore,
  useSavedPlacesStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { AccountAvatarButton } from "@/components/auth/AccountAvatarButton";
import { BRAND } from "@/integration-api/runtime/theme";

const openMenu = () => useMenuStore.getState().open();

interface SearchBarLeadingProps {
  fullScreen: boolean;
  isMobile: boolean;
  onBack: () => void;
}

/** The control before the input: back out of the full-screen search or a list, or the menu. */
export function SearchBarLeading({ fullScreen, isMobile, onBack }: SearchBarLeadingProps) {
  const t = useTranslations("search");
  const tCommon = useTranslations("common");
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  if (fullScreen || selectedListId) {
    return (
      <IconButton
        size="small"
        sx={{ ml: 0.5, mr: 0.5 }}
        onClick={fullScreen ? onBack : () => useSavedPlacesStore.getState().clearSelectedList()}
        aria-label={tCommon("back")}
      >
        <ArrowBackIcon sx={{ fontSize: 22, color: "text.secondary" }} />
      </IconButton>
    );
  }
  if (isMobile) {
    // On a phone the avatar opens the one menu, so the field starts with its
    // own glyph instead of a second menu button.
    return (
      <SearchIcon
        aria-hidden
        sx={{ fontSize: 22, color: "text.secondary", ml: 1.25, mr: 0.75, flexShrink: 0 }}
      />
    );
  }
  return (
    <IconButton
      size="small"
      sx={{ ml: 0.5, mr: 0.5 }}
      onClick={openMenu}
      aria-label={t("menuAriaLabel")}
    >
      <MenuIcon sx={{ fontSize: 22, color: "text.secondary" }} />
    </IconButton>
  );
}

interface SearchBarTrailingProps {
  fullScreen: boolean;
  nearbyMode: boolean;
  hasQuery: boolean;
  /** Abandons a submission in progress before another control acts. */
  onCancelSubmission: () => void;
  onClear: () => void;
  onCancelNearby: () => void;
}

/** The controls after the input: clear or submit, close or directions, account, nearby pill. */
export function SearchBarTrailing({
  fullScreen,
  nearbyMode,
  hasQuery,
  onCancelSubmission,
  onClear,
  onCancelNearby,
}: SearchBarTrailingProps) {
  const t = useTranslations("search");
  const tCommon = useTranslations("common");
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();

  if (fullScreen) {
    return hasQuery ? (
      <IconButton size="small" onClick={onClear} aria-label={tCommon("clear")}>
        <HighlightOffIcon sx={{ fontSize: 22, color: "text.secondary" }} />
      </IconButton>
    ) : null;
  }
  return (
    <>
      <IconButton
        type="submit"
        size="small"
        aria-label={t("searchAriaLabel")}
        // Don't let the button steal focus from the input — otherwise
        // the blur handler collapses the suggestions/AI card on click,
        // unlike pressing Enter (which keeps focus). The click still submits.
        onMouseDown={(e) => e.preventDefault()}
        sx={{ display: { xs: "none", sm: "inline-flex" } }}
      >
        <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
      </IconButton>
      {nearbyMode ? (
        <NearbyPill onCancel={onCancelNearby} />
      ) : (
        <>
          {hasSidePanel ? (
            <IconButton
              size="small"
              aria-label={t("closePanelAriaLabel")}
              sx={{ ml: 1, mr: 0.5 }}
              onClick={() => {
                onCancelSubmission();
                closeSidePanel();
                useSearchStore.getState().setQuery("");
              }}
            >
              <CloseIcon sx={{ fontSize: 22, color: "text.secondary" }} />
            </IconButton>
          ) : (
            <Tooltip title={t("directionsTooltip")} placement="bottom">
              <IconButton
                size="small"
                aria-label={t("getDirectionsAriaLabel")}
                sx={{ ml: 1, mr: 0.5 }}
                onClick={() => {
                  onCancelSubmission();
                  useDirectionsStore.getState().open();
                  useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
                }}
              >
                <DirectionsIcon sx={{ fontSize: 22, color: BRAND }} />
              </IconButton>
            </Tooltip>
          )}
          {/* Account avatar — inline in the search bar on mobile. The desktop
              equivalent is a separate floating control rendered by
              TopRightControls. Hidden when the search has expanded to
              fullscreen — it's not relevant while the user is typing a query. */}
          <Box sx={{ display: { xs: "inline-flex", sm: "none" }, ml: 0.25, mr: 0.25 }}>
            <AccountAvatarButton size={32} onOpen={openMenu} openLabel={t("menuAriaLabel")} />
          </Box>
        </>
      )}
    </>
  );
}

/**
 * Replaces the right-side controls while a place is anchored. The ✕ cancels
 * the nearby search and reopens the place.
 */
function NearbyPill({ onCancel }: { onCancel: () => void }) {
  const t = useTranslations("search");
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        bgcolor: BRAND,
        color: "#fff",
        borderRadius: 999,
        ml: 1,
        mr: 0.5,
        pl: 1,
        pr: 0.25,
        height: 32,
        flexShrink: 0,
      }}
    >
      <MyLocationIcon sx={{ fontSize: 18 }} />
      <Divider
        orientation="vertical"
        flexItem
        sx={{ borderColor: "rgba(255,255,255,0.4)", mx: 0.5, my: 0.75 }}
      />
      <Tooltip title={t("cancelNearby")} placement="bottom">
        <IconButton
          size="small"
          onClick={onCancel}
          aria-label={t("cancelNearby")}
          sx={{
            color: "#fff",
            p: 0.25,
            "&:hover": { bgcolor: "rgba(255,255,255,0.15)" },
          }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
