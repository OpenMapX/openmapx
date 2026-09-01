import type { CameraMode, NavKind, NavStatus } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import {
  getMapObstructionInsets,
  type MapInsets,
  subscribeMapObstructions,
} from "./mapObstructions";

/** Where the follow puck sits down the visible strip while navigating. */
export const PUCK_SCREEN_RATIO = 0.75;
/**
 * Chrome-derived padding on an axis is scaled down together until it leaves at
 * least this share of the axis — and at least {@link MIN_VISIBLE_PX} — visible.
 * The follow-puck offset is then added on top and is deliberately not
 * re-clamped, so an active puck offset can push the visible strip below this.
 */
export const MIN_VISIBLE_FRACTION = 0.3;
export const MIN_VISIBLE_PX = 160;

export interface CameraPaddingInputs {
  insets: MapInsets;
  viewport: { width: number; height: number };
  /** Ground navigation is placing the puck below the visible center. */
  puckOffset: boolean;
}

/** MapLibre's own `PaddingOptions` leaves each edge optional; these carry all four. */
export type ResolvedPadding = Required<maplibregl.PaddingOptions>;

const NO_PADDING: ResolvedPadding = { top: 0, bottom: 0, left: 0, right: 0 };

function sane(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampPair(near: number, far: number, extent: number): [number, number] {
  const minVisible = Math.max(MIN_VISIBLE_PX, MIN_VISIBLE_FRACTION * extent);
  const budget = Math.max(0, extent - minVisible);
  const total = near + far;
  if (total <= budget || total === 0) return [near, far];
  const scale = budget / total;
  return [near * scale, far * scale];
}

export function resolveCameraPadding({
  insets,
  viewport,
  puckOffset,
}: CameraPaddingInputs): ResolvedPadding {
  const { width, height } = viewport;
  if (!(width > 0) || !(height > 0)) return { ...NO_PADDING };
  const [left, right] = clampPair(sane(insets.left), sane(insets.right), width);
  const [clampedTop, bottom] = clampPair(sane(insets.top), sane(insets.bottom), height);
  let top = clampedTop;
  if (puckOffset) {
    const visibleHeight = height - top - bottom;
    top += (2 * PUCK_SCREEN_RATIO - 1) * visibleHeight;
  }
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    left: Math.round(left),
    right: Math.round(right),
  };
}

export function paddingEquals(
  a: maplibregl.PaddingOptions,
  b: maplibregl.PaddingOptions,
  tolerancePx = 0.5,
): boolean {
  return (
    Math.abs((a.top ?? 0) - (b.top ?? 0)) <= tolerancePx &&
    Math.abs((a.bottom ?? 0) - (b.bottom ?? 0)) <= tolerancePx &&
    Math.abs((a.left ?? 0) - (b.left ?? 0)) <= tolerancePx &&
    Math.abs((a.right ?? 0) - (b.right ?? 0)) <= tolerancePx
  );
}

export interface NavCameraState {
  status: NavStatus;
  kind: NavKind;
  cameraMode: CameraMode;
}

export function puckOffsetActive(nav: NavCameraState): boolean {
  const active = nav.status === "navigating" || nav.status === "rerouting";
  return active && nav.kind === "ground" && nav.cameraMode !== "overview";
}

/** The padding this map should carry right now. */
export function getCameraPaddingTarget(map: maplibregl.Map): ResolvedPadding {
  const container = map.getContainer();
  return resolveCameraPadding({
    insets: getMapObstructionInsets(),
    viewport: { width: container.clientWidth, height: container.clientHeight },
    puckOffset: puckOffsetActive(useNavigationStore.getState()),
  });
}

/** Fires whenever any input of `getCameraPaddingTarget` may have changed. */
export function subscribeCameraPaddingTarget(
  map: maplibregl.Map,
  listener: () => void,
): () => void {
  const unsubscribeObstructions = subscribeMapObstructions(listener);
  const unsubscribeNavigation = useNavigationStore.subscribe((state, previous) => {
    if (
      state.status !== previous.status ||
      state.kind !== previous.kind ||
      state.cameraMode !== previous.cameraMode
    ) {
      listener();
    }
  });
  map.on("resize", listener);
  return () => {
    unsubscribeObstructions();
    unsubscribeNavigation();
    map.off("resize", listener);
  };
}
