"use client";

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import { integrationIdToOverlayId, useNavigationStore, useSidebarStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { type ComponentType, lazy, Suspense, useMemo, useState } from "react";
import { useAnyOverlayPanelOpen } from "@/integration-api/overlay/useOverlayStoreState";
import { isPanelShiftActive, PANEL_WIDTH } from "@/lib/layout";
import { useMobilePanelClearance, useWindowHeight } from "@/lib/mobilePanelHeight";
import { DeclarativeLegend } from "./overlay/DeclarativeLegend";
import { dedupeSharedMapLayers } from "./sharedIntegrationLayer";

const FLUSH_BOTTOM = "var(--omx-safe-bottom)";

function resolveDefault(mod: Record<string, unknown>): { default: ComponentType } {
  const Component = (mod.default ??
    Object.values(mod).find((v) => typeof v === "function")) as ComponentType;
  return { default: Component };
}

function BuiltInLegend({ id }: { id: string }) {
  const LazyLegend = useMemo(
    () =>
      lazy(() =>
        import(
          /* webpackChunkName: "integration-legend-[request]" */
          `@integrations/${id}/legend`
        ).then(resolveDefault),
      ),
    [id],
  );

  return (
    <Suspense fallback={null}>
      <LazyLegend />
    </Suspense>
  );
}

export function LegendHost() {
  const registry = useIntegrationRegistry();
  const t = useTranslations("map");

  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const activeDetailId = useSidebarStore((s) => s.activeDetailId);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const measurementActive = useMeasurementStore((s) => s.isActive);
  const travelTimeActive = useTravelTimeStore((s) => s.isActive);

  // Overlay legends are map-browsing chrome. They stay one tap away via the
  // toggle, but default to hidden while the map isn't the user's focus — during
  // navigation, or with a sidebar/detail panel (directions, place card, or the
  // mobile bottom sheet) expanded over it.
  const panelExpanded = (activeSidebarId !== null || activeDetailId !== null) && !collapsed;
  const guardActive = navigating || panelExpanded;

  // null = follow the context default; true/false = the user's explicit choice.
  // Reset it whenever the context (guarded ↔ free) flips so each session starts
  // from its sensible default — React's store-the-previous-render-value pattern,
  // which resets during render without an effect.
  const [override, setOverride] = useState<boolean | null>(null);
  const [prevGuardActive, setPrevGuardActive] = useState(guardActive);
  if (guardActive !== prevGuardActive) {
    setPrevGuardActive(guardActive);
    setOverride(null);
  }
  const showLegends = override ?? !guardActive;

  // Shift with the left sidebar so the stack stays centred in the visible map,
  // exactly as the footer/attribution do (same predicate + PANEL_WIDTH).
  const shifted = isPanelShiftActive({
    sidebarOpen: activeSidebarId !== null,
    sidebarCollapsed: collapsed,
    navigating,
  });

  // Follow the bottom-anchored mobile sheet so the stack sits above it, never
  // behind it — same follow logic MapControls uses. Browsing panels and the
  // navigation swipe sheet all register their live height in the same registry,
  // so there is no per-context clearance to keep in sync. 0 on desktop.
  const vh = useWindowHeight();
  const followHeight = useMobilePanelClearance(vh);

  // Declarative legends (manifest `frontend.overlay.legend` data) are rendered by
  // the host; they take precedence over the code legend path.
  const declarative = registry.getAll().filter((i) => i.enabled && i.frontend?.overlay?.legend);
  const declarativeIds = new Set(declarative.map((i) => i.id));
  const codeLegends = dedupeSharedMapLayers(
    registry.getWithLegend().filter((i) => i.isBuiltIn !== false && !declarativeIds.has(i.id)),
  );

  // A normal legend integration being *enabled* (installed) doesn't mean its
  // overlay is active — each legend renders only when its overlay panel is open
  // (see OverlayLegend). The measurement and travel-time integrations are
  // standalone toolbars, though: they deliberately use their own `isActive`
  // stores instead of the generic panel state.
  const overlayIds = [...declarative, ...codeLegends].map((i) => integrationIdToOverlayId(i.id));
  const anyPanelOpen = useAnyOverlayPanelOpen(overlayIds);
  const anyStandaloneToolbarActive = measurementActive || travelTimeActive;

  if (!anyPanelOpen && !anyStandaloneToolbarActive) return null;

  const bottom = {
    // Flush against the top edge of the mobile bottom sheet (no gap).
    xs: followHeight > 0 ? `calc(${followHeight}px + var(--omx-safe-bottom))` : FLUSH_BOTTOM,
    sm: FLUSH_BOTTOM,
  };

  return (
    <Box
      sx={{
        position: "absolute",
        bottom,
        left: { xs: "50%", sm: shifted ? `calc(50% + ${PANEL_WIDTH / 2}px)` : "50%" },
        transform: "translateX(-50%)",
        transition: "left 0.25s ease, bottom 0.25s ease",
        zIndex: 10,
        // column-reverse: the toggle (first child) sits flush at the bottom edge
        // and the legends stack upward above it.
        display: "flex",
        flexDirection: "column-reverse",
        alignItems: "center",
        gap: 1,
        pointerEvents: "none",
        "& > *": { pointerEvents: "auto" },
      }}
    >
      <IconButton
        onClick={() => setOverride(!showLegends)}
        aria-label={showLegends ? t("hideLegend") : t("showLegend")}
        sx={{
          // Square tab flush with the bottom edge, rounded top — mirrors the
          // sidebar collapse toggle's flush-tab treatment.
          bgcolor: "background.paper",
          borderRadius: "6px 6px 0 0",
          boxShadow: "0 -2px 8px var(--omx-shadow-soft)",
          width: 54,
          height: 22,
          padding: 0,
          // Re-assert bgcolor on hover — MUI's IconButton default hover sets a
          // translucent backgroundColor that otherwise makes the tab see-through.
          "&:hover": { bgcolor: "background.paper", filter: "brightness(0.92)" },
        }}
      >
        {showLegends ? (
          <KeyboardArrowDownIcon sx={{ fontSize: 18 }} />
        ) : (
          <KeyboardArrowUpIcon sx={{ fontSize: 18 }} />
        )}
      </IconButton>
      {showLegends &&
        declarative.map((integration) => (
          <DeclarativeLegend key={integration.id} integration={integration} />
        ))}
      {showLegends &&
        codeLegends.map((integration) => (
          <BuiltInLegend key={integration.id} id={integration.id} />
        ))}
    </Box>
  );
}
