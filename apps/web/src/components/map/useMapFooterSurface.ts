"use client";

import { useLayoutEffect, useState } from "react";
import { MAP_FOOTER_OBSTRUCTION_ID, publishMapFooterCenterCovered } from "@/lib/mapFooterCenter";
import {
  getMapObstructionInsets,
  publishMapObstruction,
  subscribeMapObstructions,
} from "@/lib/mapObstructions";
import { subscribeMobileFooterSurfaces, topMobileFooterSurface } from "@/lib/mobileFooterSurface";

/**
 * One portal target for the controller's whole lifetime. Only its physical parent changes.
 * `centerCovered` reports whether footer content runs under the legend tab; it
 * is republished with every move, so a footer leaving the sheet is not left
 * reporting the "clear" state it had inside it until React next renders.
 */
export function useMapFooterSurface(
  footer: HTMLElement | null,
  mobile: boolean,
  centerCovered: () => boolean,
) {
  const [home, setHome] = useState<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState({ docked: false, mapBudget: 0 });
  useLayoutEffect(() => {
    const node = document.createElement("div");
    node.dataset.mapFooterSurface = "map";
    node.style.display = "contents";
    setContainer(node);
    return () => node.remove();
  }, []);

  useLayoutEffect(() => {
    if (!container || !home) return;
    let owner: HTMLElement | null = null;
    let updating = false;
    const update = () => {
      if (updating) return;
      updating = true;
      const surface = mobile ? topMobileFooterSurface() : null;
      const vv = window.visualViewport;
      const viewportTop = vv?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (vv?.height ?? window.innerHeight);
      const top = Math.max(viewportTop, getMapObstructionInsets().top);
      const follow = surface ? Math.min(surface.visibleHeight, surface.followCap) : 0;
      const mapBottom = surface
        ? Math.min(viewportBottom, surface.bottom - follow)
        : viewportBottom;
      const mapBudget = Math.max(0, mapBottom - top);
      // One pixel tolerates the engine's fractional snap-marker boundary. The
      // hypothetical rectangle is independent of the current physical parent.
      const docked =
        !!surface &&
        (mapBottom > surface.bottom - surface.visibleHeight + 1 ||
          (footer?.getBoundingClientRect().height ?? 0) > mapBudget + 1);
      const nextOwner = docked ? surface.host : null;
      if (owner !== nextOwner) {
        owner?.removeAttribute("data-map-footer-owned");
        owner?.style.removeProperty("--omx-footer-keyboard-avoidance");
        owner = nextOwner;
      }
      if (owner && surface) {
        owner.setAttribute("data-map-footer-owned", "");
        owner.style.setProperty(
          "--omx-footer-keyboard-avoidance",
          `${Math.max(0, surface.bottom - viewportBottom)}px`,
        );
      }
      container.dataset.mapFooterSurface = docked ? "sheet" : "map";
      // With no sheet retain the established safe-area inset; the keyboard
      // offset replaces it only while the visual viewport is actually smaller.
      const bottom = window.innerHeight - mapBottom;
      container.style.setProperty(
        "--omx-map-footer-bottom",
        surface || bottom > 0 ? `${bottom}px` : "var(--omx-safe-bottom)",
      );
      const target = docked ? surface.outlet : home;
      if (container.parentElement !== target) {
        const focused = document.activeElement;
        const restore = focused instanceof HTMLElement && container.contains(focused);
        target.appendChild(container);
        if (restore && focused.isConnected && document.activeElement !== focused)
          focused.focus({ preventScroll: true });
      }
      publishMapFooterCenterCovered(centerCovered());
      if (footer)
        publishMapObstruction(
          MAP_FOOTER_OBSTRUCTION_ID,
          "bottom",
          window.innerHeight - footer.getBoundingClientRect().top,
        );
      setPlacement((previous) =>
        previous.docked === docked && previous.mapBudget === mapBudget
          ? previous
          : { docked, mapBudget },
      );
      updating = false;
    };
    update();
    const unsubscribe = subscribeMobileFooterSurfaces(update);
    const unsubscribeObstructions = subscribeMapObstructions(update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (footer) observer?.observe(footer);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      unsubscribe();
      unsubscribeObstructions();
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      owner?.removeAttribute("data-map-footer-owned");
      owner?.style.removeProperty("--omx-footer-keyboard-avoidance");
    };
  }, [container, home, footer, mobile, centerCovered]);
  return { container, setHome, ...placement };
}
