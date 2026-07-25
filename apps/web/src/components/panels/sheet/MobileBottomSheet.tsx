"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTheme } from "@mui/material/styles";
import { useTranslations } from "next-intl";
import { BottomSheet, type BottomSheetElement } from "pure-web-bottom-sheet/react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { haptics } from "@/lib/haptics";
import { publishMobilePanelHeight, useMobilePanelFollowCap } from "@/lib/mobilePanelHeight";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { SHEET_PART_STYLES, sheetChromeVars } from "./chrome";
import { type Detent, type DetentConfig, detentIndex, snapSlots } from "./detents";
import { DetailChromeContext, FloatingHandleContext } from "./mobileSheetShared";
import { peekContentHeight, visibleSheetHeight } from "./sheetMetrics";
import {
  detentFromSnapEvent,
  type MobileSheetApi,
  MobileSheetContext,
  type SnapDetail,
} from "./sheetState";

/**
 * Resizing the sheet from the keyboard. The handle lives in the shadow root
 * and cannot take our handlers, so this binds to the host — which is also the
 * scroll container, so arrow keys already move the sheet natively; this makes
 * the movement land on detents. Steps straight from peek to full when the
 * config has no mid detent.
 */
export function keyboardDetent(key: string, current: Detent, config: DetentConfig): Detent | null {
  if (key === "Home") return current === "peek" ? null : "peek";
  if (key === "End") return current === "full" ? null : "full";
  const step = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
  if (step === 0) return null;
  const order: Detent[] = config.mid != null ? ["peek", "mid", "full"] : ["peek", "full"];
  const next = order[order.indexOf(current) + step];
  return next ?? null;
}

/**
 * React delegates keydown, so the host's handler also fires for events
 * bubbling up from every descendant — date/time inputs, Autocomplete lists,
 * anything with its own arrow-key or Home/End behavior. Only a key that
 * originated on the host itself (reachable via its `tabIndex`, not by
 * delegation) should move the sheet.
 */
export function isHostKeyDown(event: { target: unknown; currentTarget: unknown }): boolean {
  return event.target === event.currentTarget;
}

interface Props {
  id: string;
  zIndex: number;
  detents: DetentConfig;
  /**
   * Drives the sheet's resting detent from outside — e.g. a caller collapsing
   * it after handling a menu action. A no-op when it already matches the
   * sheet's current detent, so this never fights a drag or tap in progress.
   */
  detent?: Detent;
  /**
   * Fires as the resting detent changes. Not just on rest, despite the name:
   * the library dispatches `snap-position-change` from an IntersectionObserver
   * (`rootMargin: "100% 0px -100% 0px"`) as snap markers cross during the
   * drag itself, so this can fire mid-gesture, before the finger lifts.
   */
  onDetentChange?: (detent: Detent) => void;
  /**
   * Hides the library's own drag-pill part, for a caller that renders its own
   * (labeled, tappable) handle as part of `header` instead.
   */
  hideHandle?: boolean;
  /**
   * Omits the generic bottom safe-area padding from the content part, for a
   * caller that positions its own safe-area padding depending on which of its
   * regions is currently the sheet's visible bottom edge.
   */
  disableContentSafeArea?: boolean;
  /**
   * Another sheet is stacked on top of this one. Mobile shows one sheet at a
   * time, so the covered one is taken out of play entirely — hidden, untouchable,
   * out of the tab order and the accessibility tree — while staying mounted so
   * its scroll position and state survive the trip. Desktop shows both panels
   * side by side and never sets this.
   */
  obscured?: boolean;
  /**
   * Accessible name for the sheet's landmark. Two sheets both announcing
   * "Panel" tells a screen-reader user nothing about which is which.
   */
  ariaLabel?: string;
  /** Applied to the scrollable content, not the host. */
  contentSx?: SxProps<Theme>;
  children: ReactNode;
}

export function MobileBottomSheet({
  id,
  zIndex,
  detents,
  detent,
  onDetentChange,
  hideHandle,
  disableContentSafeArea,
  obscured,
  ariaLabel,
  contentSx,
  children,
}: Props) {
  const theme = useTheme();
  const t = useTranslations("common");
  const [host, setHost] = useState<BottomSheetElement | null>(null);
  const [peekEl, setPeekEl] = useState<HTMLElement | null>(null);
  const [peekPx, setPeekPx] = useState<number | null>(null);
  const [midPx, setMidPx] = useState<number | null>(null);
  const [floating, setFloating] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [state, setState] = useState<{ detent: Detent; isExpanded: boolean }>({
    detent: detents.initial,
    isExpanded: false,
  });
  const detentRef = useRef<Detent>(detents.initial);
  // Read fresh inside the snap listener without re-subscribing it whenever
  // the caller passes a new callback identity.
  const onDetentChangeRef = useRef(onDetentChange);
  useEffect(() => {
    onDetentChangeRef.current = onDetentChange;
  }, [onDetentChange]);
  // Registered by descendant content through useDetailChrome — the pinned
  // header / docked footer slots. Owned here (rather than by DetailShell)
  // so every surface that renders a sheet gets the bridge, not just the
  // place detail one.
  const [chromeHeader, setChromeHeader] = useState<ReactNode>(null);
  const [chromeFooter, setChromeFooter] = useState<ReactNode>(null);
  const chromeApi = useMemo(() => ({ setHeader: setChromeHeader, setFooter: setChromeFooter }), []);
  const { keyboardInset } = useVisualViewport();
  // Only lift the sheet when the keyboard was raised by a field inside it —
  // the app's top search bar also raises the keyboard, and lifting the sheet
  // then would be wrong.
  const keyboardLift = focusInside ? keyboardInset : 0;

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

  // Track whether focus is on an element *inside* the sheet, so the keyboard
  // lift below only applies when the user is typing in the sheet itself.
  useEffect(() => {
    if (!host) return;
    let frame = 0;
    const onFocusIn = () => setFocusInside(host.contains(document.activeElement));
    // Defer: during focusout the next element has not been focused yet, so
    // reading activeElement now would drop the lift whenever focus moves
    // between two fields inside the sheet.
    const onFocusOut = () => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        setFocusInside(host.contains(document.activeElement));
      });
    };
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    return () => {
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [host]);

  useMobilePanelFollowCap(id, obscured ? null : midPx);

  const snapTo = useCallback(
    (target: Detent, options?: { animate?: boolean }) => {
      const index = detentIndex(detents)[target];
      if (index == null) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const behavior = options?.animate === false || reduced ? "auto" : "smooth";
      host?.snapToPoint?.(index, { behavior });
    },
    [host, detents],
  );

  // The React wrapper only spreads props onto the custom element; it wires no
  // events, so the listener has to be attached imperatively.
  useEffect(() => {
    if (!host) return;
    const onSnap = (event: Event) => {
      const next = detentFromSnapEvent((event as CustomEvent<SnapDetail>).detail, detents);
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
  }, [host, detents]);

  // Controlled operation: an external change to `detent` (a caller collapsing
  // the sheet after handling a menu action, or driving it from a boolean prop
  // like the navigation sheet's `expanded`) snaps the host to match. Guarded
  // against the sheet's own current detent so this never re-fires for a
  // change that originated from the sheet itself (a drag or a tap), which
  // would otherwise fight the gesture that's already in progress.
  useEffect(() => {
    if (detent == null || detent === detentRef.current) return;
    snapTo(detent);
  }, [detent, snapTo]);

  // The visible height has to be derived from the host's scroll offset, not
  // measured directly, so it needs republishing on scroll. It also needs
  // republishing on resize: the host's own box is not fixed for every sheet —
  // the navigation sheet's `--sheet-max-height` (and so `clientHeight`)
  // changes whenever its measured content changes, with no scroll guaranteed
  // to accompany that.
  useEffect(() => {
    if (!host) return;
    // A covered sheet is not on screen, so map chrome must clear the visible
    // one rather than whichever of the two happens to be taller.
    if (obscured) {
      publishMobilePanelHeight(id, null);
      return;
    }
    let frame = 0;
    const publish = () => {
      frame = 0;
      publishMobilePanelHeight(id, visibleSheetHeight(host));
    };
    const onChange = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };
    publish();
    host.addEventListener("scroll", onChange, { passive: true });
    const ro = new ResizeObserver(onChange);
    ro.observe(host);
    return () => {
      host.removeEventListener("scroll", onChange);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
      publishMobilePanelHeight(id, null);
    };
  }, [host, id, obscured]);

  // Resolve the mid snap to pixels for the follow cap. Snap markers are 1px
  // targets offset by `top: calc(var(--snap) - 1px)` inside the fixed host, so
  // offsetTop + 1 is the detent height — the same arithmetic the library does.
  // Requires `defined`: before the host upgrades, `::slotted` rules haven't
  // applied yet and every marker sits at the same flow position.
  useEffect(() => {
    if (!host || !defined) return;
    const update = () => {
      const midIndex = detentIndex(detents).mid;
      const markers = host.querySelectorAll<HTMLElement>(':scope > [slot="snap"]');
      const mid = midIndex != null ? markers[midIndex - 1] : undefined;
      setMidPx(mid ? mid.offsetTop + 1 : null);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [host, defined, detents]);

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
    // A panel marks the subtree it wants visible when collapsed. Resolve that
    // marker on every measurement rather than capturing it once: a panel swaps
    // its subtree as data loads, and an observer left watching the detached
    // original freezes peek at whatever was measured mid-load.
    //
    // A panel with no marker keeps the configured peek height. Measuring the
    // whole panel instead would exceed the middle detent, and the clamp would
    // then fold peek onto it — two reachable positions where there should be
    // three.
    const ro = new ResizeObserver(() => measure());
    // A panel swap replaces the marked subtree without re-running this effect
    // (deps are [peekEl, host, defined]), so `ro.observe` alone would leave
    // every previous panel's now-detached subtree under observation for the
    // life of the sheet. Track the one currently observed and swap it out.
    let observedSubtree: HTMLElement | null = null;
    const measure = () => {
      const subtree = peekEl.querySelector<HTMLElement>("[data-omx-peek]");
      if (!subtree) {
        if (observedSubtree) {
          ro.unobserve(observedSubtree);
          observedSubtree = null;
        }
        setPeekPx(null);
        return;
      }
      if (subtree !== observedSubtree) {
        if (observedSubtree) ro.unobserve(observedSubtree);
        ro.observe(subtree);
        observedSubtree = subtree;
      }
      const header = headerEl ? headerEl.getBoundingClientRect().height : 0;
      // Regions the panel drops once collapsed. They are still rendered while
      // the sheet is open, so counting them would aim the collapse at a height
      // that ceases to exist on arrival.
      const hidden = [...subtree.querySelectorAll<HTMLElement>("[data-omx-peek-hidden]")].map(
        (region) => {
          const cs = getComputedStyle(region);
          return (
            region.getBoundingClientRect().height +
            (Number.parseFloat(cs.marginTop) || 0) +
            (Number.parseFloat(cs.marginBottom) || 0)
          );
        },
      );
      const next = peekContentHeight(subtree.getBoundingClientRect().height, hidden, header);
      setPeekPx((prev) => (prev != null && Math.abs(prev - next) < 4 ? prev : next));
    };
    // The container catches the reflow when children are added or removed; the
    // mutation observer catches a marker that moves to a different element.
    ro.observe(peekEl);
    if (headerEl) ro.observe(headerEl);
    const mo = new MutationObserver(() => measure());
    mo.observe(peekEl, { childList: true, subtree: true });
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [peekEl, host, defined]);

  useEffect(() => {
    if (peekPx != null && state.detent === "peek") snapTo("peek", { animate: false });
  }, [peekPx, state.detent, snapTo]);

  const slots = useMemo(() => snapSlots(detents, peekPx), [detents, peekPx]);
  const api = useMemo<MobileSheetApi>(
    () => ({ detent: state.detent, isExpanded: state.isExpanded, inSheet: true, snapTo }),
    [state, snapTo],
  );
  const maxHeight = detents.maxHeight;

  return (
    <DetailChromeContext.Provider value={chromeApi}>
      <MobileSheetContext.Provider value={api}>
        <FloatingHandleContext.Provider value={setFloating}>
          <Box
            component={BottomSheet}
            ref={setHost}
            nested-scroll
            expand-to-scroll
            role="region"
            aria-label={ariaLabel ?? t("panelAriaLabel")}
            // `visibility: hidden` (below) already drops a covered sheet from
            // the tab order; clearing tabIndex keeps that explicit rather than
            // relying on it, and `inert` covers anything focusable inside.
            tabIndex={obscured ? -1 : 0}
            {...(obscured ? { inert: true } : {})}
            // Inline `bottom` outranks the shadow `:host` rule, so this is how
            // the host actually moves; `--sheet-max-height` is shrunk by the
            // same amount so the top edge stays on-screen.
            style={
              {
                ...sheetChromeVars(theme, maxHeight, keyboardLift),
                bottom: keyboardLift,
              } as CSSProperties
            }
            // Pointer events are deliberately left to the shadow stylesheet:
            // the host is a full-height transparent scroll container and only
            // the sheet inside it is hit-testable, which is what keeps the map
            // draggable in the empty region above a collapsed sheet. Setting
            // `pointer-events` here would win over `:host` and swallow those
            // gestures — slotted content is already interactive without it.
            sx={[
              { zIndex },
              SHEET_PART_STYLES(theme),
              disableContentSafeArea ? { "&::part(content)": { paddingBottom: 0 } } : {},
              hideHandle ? { "&::part(handle)": { display: "none" } } : {},
              // Hidden rather than unmounted: the sheet keeps its scroll
              // position and state for when the sheet above it closes, while
              // `visibility` takes it out of paint, hit-testing, the tab order
              // and the accessibility tree — so its handle stops showing above
              // the visible sheet and can no longer swallow that sheet's drags.
              obscured ? { visibility: "hidden" } : {},
            ]}
            {...(floating ? { "floating-handle": "" } : {})}
            onKeyDown={(event: ReactKeyboardEvent) => {
              if (!isHostKeyDown(event)) return;
              const next = keyboardDetent(event.key, state.detent, detents);
              if (!next) return;
              event.preventDefault();
              snapTo(next);
            }}
          >
            {slots.map((slot) => (
              <div
                // Keyed by which detent this is, not by `slot.snap`: for the
                // navigation sheet that value is the measured header height,
                // which changes whenever the maneuver banner rewraps. Keying
                // by value would remount the very marker the browser is
                // snapped to mid-drive.
                key={slot.detent}
                slot="snap"
                className={slot.className}
                style={{ "--snap": slot.snap } as CSSProperties}
              />
            ))}
            {chromeHeader ? <div slot="header">{chromeHeader}</div> : null}
            <Box ref={setPeekEl} sx={contentSx}>
              {children}
            </Box>
            {chromeFooter ? <div slot="footer">{chromeFooter}</div> : null}
          </Box>
        </FloatingHandleContext.Provider>
      </MobileSheetContext.Provider>
    </DetailChromeContext.Provider>
  );
}
