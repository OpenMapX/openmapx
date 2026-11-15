"use client";

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { integrationIdToOverlayId, useNavigationStore, useSidebarStore } from "@openmapx/core";
import type { IntegrationMetadata } from "@openmapx/core/api-contracts";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { type ComponentType, lazy, Suspense, useMemo, useState } from "react";
import { EmbeddedLegendContext } from "@/integration-api/overlay/OverlayLegend";
import { useOpenOverlayIds } from "@/integration-api/overlay/useOverlayStoreState";
import { isPanelShiftActive, PANEL_WIDTH } from "@/lib/layout";
import {
  LEGEND_TOGGLE_WIDTH,
  MAP_FOOTER_OBSTRUCTION_ID,
  useMapFooterBox,
  useMapFooterCenterCovered,
} from "@/lib/mapFooterCenter";
import { useMapObstructionExtent } from "@/lib/mapObstructions";
import { useMobilePanelClearance, useWindowHeight } from "@/lib/mobilePanelHeight";
import {
  planAboveFooter,
  planSheetFollow,
  sheetFollowSx,
  useSheetFollowTrack,
} from "@/lib/sheetFollow";
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
  const tLayers = useTranslations("layers");

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
  const footerExtent = useMapObstructionExtent(MAP_FOOTER_OBSTRUCTION_ID);
  const footerCoversCenter = useMapFooterCenterCovered();
  const footerBox = useMapFooterBox();
  const followTrack = useSheetFollowTrack();

  // Declarative legends (manifest `frontend.overlay.legend` data) are rendered by
  // the host; they take precedence over the code legend path.
  const declarative = registry.getAll().filter((i) => i.enabled && i.frontend?.overlay?.legend);
  const declarativeIds = new Set(declarative.map((i) => i.id));
  const codeLegends = dedupeSharedMapLayers(
    registry.getWithLegend().filter((i) => i.isBuiltIn !== false && !declarativeIds.has(i.id)),
  );

  // The measurement and travel-time tools are toolbars with their own close
  // button, driven by their own `isActive` stores; they stack above the card.
  const tools = codeLegends.filter((i) => TOOL_IDS.has(i.id));
  // Every other legend renders only while its overlay's panel is open (see
  // OverlayLegend). They share one card, one legend at a time, chosen by tab.
  const legends = [
    ...declarative.map((integration) => ({ integration, declarative: true })),
    ...codeLegends
      .filter((i) => !TOOL_IDS.has(i.id))
      .map((integration) => ({ integration, declarative: false })),
  ].map((entry) => ({ ...entry, overlayId: integrationIdToOverlayId(entry.integration.id) }));
  const openIds = useOpenOverlayIds(legends.map((l) => l.overlayId));
  const open = legends.filter((l) => openIds.includes(l.overlayId));
  const anyStandaloneToolbarActive = measurementActive || travelTimeActive;

  // The tab shown: the overlay turned on last, until the rider picks another.
  // Tracked with React's store-the-previous-render pattern, without an effect.
  const [selected, setSelected] = useState<string | null>(null);
  const openKey = openIds.join(",");
  const [prevOpenKey, setPrevOpenKey] = useState(openKey);
  if (openKey !== prevOpenKey) {
    const before = new Set(prevOpenKey.split(","));
    const added = openIds.filter((id) => !before.has(id));
    setPrevOpenKey(openKey);
    if (added.length > 0) setSelected(added[added.length - 1]);
  }
  const current = open.find((l) => l.overlayId === selected) ?? open[open.length - 1];

  if (open.length === 0 && !anyStandaloneToolbarActive) return null;

  // The tab normally sits flush on the map's bottom edge (on phones the top of
  // the sheet), over the gap between the footer's legal links and credits.
  // Only when footer text runs under it (long or wrapped credits, as on most
  // phones) does the stack stand on the footer instead, which on phones rides
  // on top of the sheet. Both edges are read as they move, and `bottom` is not
  // transitioned: an eased transition restarted on every frame of a sheet drag
  // lags the sheet and the footer by a few hundred pixels.
  const onFooter = footerCoversCenter && footerExtent > 0 ? `${footerExtent}px` : null;
  // While a sheet drives the follow, the same two edges come from its track
  // and the tab rides them on the compositor (see lib/sheetFollow).
  const follow = !followTrack
    ? null
    : footerCoversCenter
      ? planAboveFooter(followTrack, footerBox, 0, 0)
      : planSheetFollow(followTrack, { offset: 0, min: 0 });
  const bottom = {
    // The visible sheet height already includes its safe-area padding.
    xs: follow
      ? `${follow.base}px`
      : (onFooter ?? (followHeight > 0 ? `${followHeight}px` : FLUSH_BOTTOM)),
    sm: onFooter ?? FLUSH_BOTTOM,
  };
  const anchor = {
    position: "absolute",
    bottom,
    ...sheetFollowSx(follow),
    zIndex: 10,
    pointerEvents: "none",
    "& > *": { pointerEvents: "auto" },
  } as const;
  const centred = {
    left: { xs: "50%", sm: shifted ? `calc(50% + ${PANEL_WIDTH / 2}px)` : "50%" },
    transform: "translateX(-50%)",
    // Matches the footer's own `left` transition as the sidebar shifts.
    transition: "left 0.25s ease",
  } as const;
  const expanded = showLegends && open.length > 0;
  const collapse = (
    <IconButton
      onClick={() => setOverride(false)}
      aria-label={t("hideLegend")}
      sx={{ mx: 0.5, flexShrink: 0 }}
    >
      <KeyboardArrowDownIcon />
    </IconButton>
  );

  return (
    <>
      {!expanded && open.length > 0 && (
        <Box sx={{ ...anchor, ...centred }}>
          <IconButton
            onClick={() => setOverride(true)}
            aria-label={t("showLegend")}
            sx={{
              // Square tab flush with the bottom edge, rounded top — mirrors the
              // sidebar collapse toggle's flush-tab treatment.
              bgcolor: "background.paper",
              borderRadius: "6px 6px 0 0",
              boxShadow: "0 -2px 8px var(--omx-shadow-soft)",
              width: LEGEND_TOGGLE_WIDTH,
              height: 22,
              padding: 0,
              // Re-assert bgcolor on hover — MUI's IconButton default hover sets a
              // translucent backgroundColor that otherwise makes the tab see-through.
              "&:hover": { bgcolor: "background.paper", filter: "brightness(0.92)" },
            }}
          >
            <KeyboardArrowUpIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
      )}
      {(expanded || anyStandaloneToolbarActive) && (
        <Box
          data-legend-anchor
          sx={{
            ...anchor,
            // On a phone the card keeps clear of the map controls on the right;
            // with room to spare it centres on the visible map.
            left: { xs: 8, sm: centred.left.sm },
            right: { xs: CONTROLS_CLEARANCE, sm: "auto" },
            transform: { xs: "none", sm: centred.transform },
            transition: centred.transition,
            mb: 1,
            display: "flex",
            flexDirection: "column-reverse",
            alignItems: { xs: "stretch", sm: "center" },
            gap: 1,
          }}
        >
          {expanded && current && (
            <Paper
              elevation={3}
              role="region"
              aria-label={t("legend")}
              sx={{
                width: { sm: 400 },
                maxHeight: { xs: "45dvh", sm: "55vh" },
                display: "flex",
                flexDirection: "column",
                borderRadius: "16px",
                overflow: "hidden",
              }}
            >
              {open.length > 1 && (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    borderBottom: 1,
                    borderColor: "divider",
                    flexShrink: 0,
                  }}
                >
                  <Tabs
                    value={current.overlayId}
                    onChange={(_, value: string) => setSelected(value)}
                    variant="scrollable"
                    scrollButtons={false}
                    aria-label={t("legend")}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 44,
                      // Tabs that run past the edge fade out there, hinting at the rest.
                      "& .MuiTabs-scroller": {
                        maskImage: "linear-gradient(to right, #000 calc(100% - 16px), transparent)",
                      },
                      "& .MuiTab-root": {
                        minHeight: 44,
                        minWidth: 0,
                        px: 1.5,
                        textTransform: "none",
                        fontSize: 14,
                      },
                    }}
                  >
                    {open.map((legend) => (
                      <Tab
                        key={legend.overlayId}
                        value={legend.overlayId}
                        label={legendLabel(legend.integration, tLayers)}
                        id={`legend-tab-${legend.overlayId}`}
                        aria-controls="legend-panel"
                      />
                    ))}
                  </Tabs>
                  {collapse}
                </Box>
              )}
              <Box
                id="legend-panel"
                role="tabpanel"
                aria-labelledby={`legend-tab-${current.overlayId}`}
                sx={{ overflowY: "auto", minHeight: 0 }}
              >
                <EmbeddedLegendContext.Provider
                  value={
                    open.length > 1
                      ? { label: legendLabel(current.integration, tLayers) }
                      : { label: null, action: collapse }
                  }
                >
                  {current.declarative ? (
                    <DeclarativeLegend
                      key={current.integration.id}
                      integration={current.integration}
                    />
                  ) : (
                    <BuiltInLegend key={current.integration.id} id={current.integration.id} />
                  )}
                </EmbeddedLegendContext.Provider>
              </Box>
            </Paper>
          )}
          {tools.map((integration) => (
            <BuiltInLegend key={integration.id} id={integration.id} />
          ))}
        </Box>
      )}
    </>
  );
}

/** The standalone overlay tools, which are toolbars rather than legends. */
const TOOL_IDS = new Set(["overlay-tool-measurement", "overlay-tool-travel-time"]);
/** Room a phone leaves on the right for the map controls' column. */
const CONTROLS_CLEARANCE = 72;

/** A legend's tab: the overlay's name in the layer picker (`layers` namespace). */
function legendLabel(integration: IntegrationMetadata, t: (key: string) => string): string {
  const key = integration.frontend?.layerSelector?.labelKey;
  return key ? t(key) : integration.name;
}
