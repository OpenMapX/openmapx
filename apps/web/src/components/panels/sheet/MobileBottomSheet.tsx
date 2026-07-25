"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTheme } from "@mui/material/styles";
import { useTranslations } from "next-intl";
import { BottomSheet, type BottomSheetElement } from "pure-web-bottom-sheet/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { haptics } from "@/lib/haptics";
import { publishMobilePanelHeight, useMobilePanelFollowCap } from "@/lib/mobilePanelHeight";
import { SHEET_PART_STYLES, sheetChromeVars } from "./chrome";
import { DETENT_INDEX, type Detent, type DetentConfig, snapSlots } from "./detents";
import { FloatingHandleContext } from "./mobileSheetShared";
import { visibleSheetHeight } from "./sheetMetrics";
import {
  detentFromSnapEvent,
  type MobileSheetApi,
  MobileSheetContext,
  type SnapDetail,
} from "./sheetState";

interface Props {
  id: string;
  zIndex: number;
  detents: DetentConfig;
  header?: ReactNode;
  footer?: ReactNode;
  /** Applied to the scrollable content, not the host. */
  contentSx?: SxProps<Theme>;
  onDetentChange?: (detent: Detent) => void;
  children: ReactNode;
}

export function MobileBottomSheet({
  id,
  zIndex,
  detents,
  header,
  footer,
  contentSx,
  onDetentChange,
  children,
}: Props) {
  const theme = useTheme();
  const t = useTranslations("common");
  const [host, setHost] = useState<BottomSheetElement | null>(null);
  const [peekEl, setPeekEl] = useState<HTMLElement | null>(null);
  const [peekPx, setPeekPx] = useState<number | null>(null);
  const [midPx, setMidPx] = useState<number | null>(null);
  const [floating, setFloating] = useState(false);
  const [state, setState] = useState<{ detent: Detent; isExpanded: boolean }>({
    detent: detents.initial,
    isExpanded: false,
  });
  const detentRef = useRef<Detent>(detents.initial);
  const onDetentChangeRef = useRef(onDetentChange);
  onDetentChangeRef.current = onDetentChange;

  // The React wrapper defines the custom element inside its own effect via an
  // async dynamic import, so on first mount the host exists but isn't upgraded
  // yet — it has no shadow root and none of its custom methods are callable.
  const [defined, setDefined] = useState(
    () => typeof window !== "undefined" && !!customElements.get("bottom-sheet"),
  );
  useEffect(() => {
    if (defined) return;
    let live = true;
    customElements.whenDefined("bottom-sheet").then(() => {
      if (live) setDefined(true);
    });
    return () => {
      live = false;
    };
  }, [defined]);

  useMobilePanelFollowCap(id, midPx);

  const snapTo = useCallback(
    (detent: Detent, options?: { animate?: boolean }) => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const behavior = options?.animate === false || reduced ? "auto" : "smooth";
      host?.snapToPoint?.(DETENT_INDEX[detent], { behavior });
    },
    [host],
  );

  // The React wrapper only spreads props onto the custom element; it wires no
  // events, so the listener has to be attached imperatively.
  useEffect(() => {
    if (!host) return;
    const onSnap = (event: Event) => {
      const next = detentFromSnapEvent((event as CustomEvent<SnapDetail>).detail);
      if (detentRef.current !== next.detent) {
        detentRef.current = next.detent;
        haptics.tap();
        onDetentChangeRef.current?.(next.detent);
      }
      setState((prev) =>
        prev.detent === next.detent && prev.isExpanded === next.isExpanded ? prev : next,
      );
    };
    host.addEventListener("snap-position-change", onSnap);
    return () => host.removeEventListener("snap-position-change", onSnap);
  }, [host]);

  // The host's box never changes size, so the visible height has to be derived
  // from its scroll offset and published directly.
  useEffect(() => {
    if (!host) return;
    let frame = 0;
    const publish = () => {
      frame = 0;
      publishMobilePanelHeight(id, visibleSheetHeight(host));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };
    publish();
    host.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      host.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      publishMobilePanelHeight(id, null);
    };
  }, [host, id]);

  // Resolve the mid snap to pixels for the follow cap. Snap markers are 1px
  // targets offset by `top: calc(var(--snap) - 1px)` inside the fixed host, so
  // offsetTop + 1 is the detent height — the same arithmetic the library does.
  // Requires `defined`: before the host upgrades, `::slotted` rules haven't
  // applied yet and every marker sits at the same flow position.
  useEffect(() => {
    if (!host || !defined) return;
    const update = () => {
      const markers = host.querySelectorAll<HTMLElement>(':scope > [slot="snap"]');
      const mid = markers[DETENT_INDEX.mid - 1];
      setMidPx(mid ? mid.offsetTop + 1 : null);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [host, defined]);

  // Peek follows its content instead of a fixed fraction. The handle and the
  // header slot sit in a sticky band ABOVE the content box, so the rendered
  // sheet is that band plus the peek subtree — measuring the subtree alone
  // leaves peek short by the header's height. Re-anchor after a rewrite so the
  // browser is not left resting on a snap target that moved. Requires
  // `defined`: before the host upgrades it has no shadow root, so the header
  // lookup would silently miss it.
  useEffect(() => {
    if (!peekEl || !host || !defined) return;
    const headerEl = host.shadowRoot?.querySelector(".sheet-header") ?? null;
    // A panel marks the subtree it wants visible when collapsed. Without that
    // marker the whole panel is measured, which the clamp then folds onto the
    // middle detent — leaving the sheet with two reachable positions instead of
    // three.
    const subtree = peekEl.querySelector<HTMLElement>("[data-omx-peek]") ?? peekEl;
    const measure = () => {
      const header = headerEl ? headerEl.getBoundingClientRect().height : 0;
      const next = Math.round(subtree.getBoundingClientRect().height + header);
      setPeekPx((prev) => (prev != null && Math.abs(prev - next) < 4 ? prev : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(subtree);
    if (headerEl) ro.observe(headerEl);
    return () => ro.disconnect();
  }, [peekEl, host, defined]);

  useEffect(() => {
    if (peekPx != null && state.detent === "peek") snapTo("peek", { animate: false });
  }, [peekPx, state.detent, snapTo]);

  const slots = useMemo(() => snapSlots(detents, peekPx), [detents, peekPx]);
  const api = useMemo<MobileSheetApi>(
    () => ({ detent: state.detent, isExpanded: state.isExpanded, snapTo }),
    [state, snapTo],
  );

  return (
    <MobileSheetContext.Provider value={api}>
      <FloatingHandleContext.Provider value={setFloating}>
        <Box
          component={BottomSheet}
          ref={setHost}
          nested-scroll
          expand-to-scroll
          role="region"
          aria-label={t("panelAriaLabel")}
          style={sheetChromeVars(theme, detents.maxHeight) as CSSProperties}
          sx={{ zIndex, ...SHEET_PART_STYLES(theme) }}
          {...(floating ? { "floating-handle": "" } : {})}
        >
          {slots.map((slot) => (
            <div
              key={slot.snap}
              slot="snap"
              className={slot.className}
              style={{ "--snap": slot.snap } as CSSProperties}
            />
          ))}
          {header ? <div slot="header">{header}</div> : null}
          <Box ref={setPeekEl} sx={contentSx}>
            {children}
          </Box>
          {footer ? <div slot="footer">{footer}</div> : null}
        </Box>
      </FloatingHandleContext.Provider>
    </MobileSheetContext.Provider>
  );
}
