"use client";

import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import { getCommunityModule } from "@openmapx/integration-framework";
import {
  useCommunityModulesVersion,
  useIntegrationRegistry,
} from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { type ComponentType, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { MOBILE_SHEET_FOLLOW_CAP_FRACTION } from "@/components/panels/mobileSheetShared";
import { useMobilePanelMaxHeight } from "@/lib/mobilePanelHeight";
import { DeclarativeLegend } from "./overlay/DeclarativeLegend";

const BASE_BOTTOM = "calc(1rem + var(--omx-safe-bottom))";
const PANEL_GAP = 12;
// Clearance above the navigation bottom bar (mirrors MapControls' NAV_BOTTOM).
const NAV_BOTTOM = 150;

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

function CommunityLegend({ id }: { id: string }) {
  const mod = getCommunityModule(id);
  if (!mod?.legend) return null;
  const Component = mod.legend;
  return <Component />;
}

export function LegendHost() {
  const registry = useIntegrationRegistry();
  // Re-render when a community bundle registers its legend after first paint.
  useCommunityModulesVersion();
  const t = useTranslations("map");

  // Overlay legends are map-browsing chrome: while the map isn't the user's focus
  // — during navigation, or with a sidebar/detail panel (directions, place card,
  // or the mobile bottom sheet) expanded over it — hide them by default behind a
  // small toggle so they don't clutter, but keep them one tap away.
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const panelExpanded = useSidebarStore(
    (s) => (s.activeSidebarId !== null || s.activeDetailId !== null) && !s.collapsed,
  );
  const guardActive = navigating || panelExpanded;

  const [revealed, setRevealed] = useState(false);
  // A fresh guarded context (new planning/nav session) starts collapsed.
  useEffect(() => {
    if (!guardActive) setRevealed(false);
  }, [guardActive]);

  // Follow the mobile bottom sheet so the toggle sits just above it, never behind
  // it — same follow logic MapControls uses. `mobilePanelHeight` is 0 on desktop,
  // so the stack stays at the base bottom offset there.
  const mobilePanelHeight = useMobilePanelMaxHeight();
  const [vh, setVh] = useState(0);
  useEffect(() => {
    const update = () => setVh(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const followHeight =
    vh > 0 ? Math.min(mobilePanelHeight, vh * MOBILE_SHEET_FOLLOW_CAP_FRACTION) : mobilePanelHeight;

  // Declarative legends (manifest `frontend.overlay.legend` data) are rendered by
  // the host; they take precedence over the code legend path.
  const declarative = registry.getAll().filter((i) => i.enabled && i.frontend?.overlay?.legend);
  const declarativeIds = new Set(declarative.map((i) => i.id));
  const codeLegends = registry.getWithLegend().filter((i) => !declarativeIds.has(i.id));

  if (declarative.length === 0 && codeLegends.length === 0) return null;

  const showLegends = !guardActive || revealed;

  const bottom = navigating
    ? `calc(${NAV_BOTTOM}px + var(--omx-safe-bottom))`
    : {
        xs:
          followHeight > 0
            ? `calc(${followHeight + PANEL_GAP}px + var(--omx-safe-bottom))`
            : BASE_BOTTOM,
        sm: BASE_BOTTOM,
      };

  return (
    <Box
      sx={{
        position: "absolute",
        bottom,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        // column-reverse: the toggle (first child) sits at the bottom edge and the
        // legends stack upward above it.
        display: "flex",
        flexDirection: "column-reverse",
        alignItems: "center",
        gap: 1,
        pointerEvents: "none",
        "& > *": { pointerEvents: "auto" },
        transition: "bottom 0.25s ease",
      }}
    >
      {guardActive && (
        <Paper elevation={3} sx={{ borderRadius: "999px" }}>
          <IconButton
            size="small"
            onClick={() => setRevealed((r) => !r)}
            aria-label={showLegends ? t("hideLegend") : t("showLegend")}
          >
            {showLegends ? (
              <KeyboardArrowDownIcon fontSize="small" />
            ) : (
              <KeyboardArrowUpIcon fontSize="small" />
            )}
          </IconButton>
        </Paper>
      )}
      {showLegends &&
        declarative.map((integration) => (
          <DeclarativeLegend key={integration.id} integration={integration} />
        ))}
      {showLegends &&
        codeLegends.map((integration) => {
          const isCommunity =
            integration.isBuiltIn === false || getCommunityModule(integration.id) !== undefined;
          return isCommunity ? (
            <CommunityLegend key={integration.id} id={integration.id} />
          ) : (
            <BuiltInLegend key={integration.id} id={integration.id} />
          );
        })}
    </Box>
  );
}
