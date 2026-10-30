"use client";

import type { LngLat } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  readCapturedContributors,
  serializeContributors,
} from "@openmapx/mobility-core/contributors";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { bindMapMarkerActivation } from "@/integration-api/map/mapMarkerActivation";
import { useMarkerMapAttributions } from "@/integration-api/overlay/useMarkerMapAttributions";
import { getMapObstructionInsets, subscribeMapObstructions } from "@/lib/mapObstructions";

interface PinColor {
  fill: string;
  stroke: string;
}

const NO_CONTRIBUTORS: readonly Attribution[] = [];
const PIN_RED: PinColor = { fill: "#EA4335", stroke: "#C5221F" };
const LABEL_MAX_WIDTH = 200;
const LABEL_GAP = 8;
/** Distance from the pin element's near edge to its label, leaving room beside the 20px-wide pin. */
const LABEL_OFFSET = "26px";

function fitPinLabel(
  map: maplibregl.Map,
  pin: HTMLElement,
  container: HTMLElement,
  label: HTMLSpanElement,
): void {
  const mapRect = map.getContainer().getBoundingClientRect();
  if (mapRect.width <= 0) return;
  const pinRect = pin.getBoundingClientRect();
  const labelRect = label.getBoundingClientRect();
  const controlsRect = document
    .querySelector<HTMLElement>("[data-map-controls-columns]")
    ?.getBoundingClientRect();
  const crossesControls =
    controlsRect && labelRect.top < controlsRect.bottom && labelRect.bottom > controlsRect.top;
  const rightEdge = Math.min(
    mapRect.right - LABEL_GAP,
    crossesControls ? controlsRect.left - LABEL_GAP : Number.POSITIVE_INFINITY,
  );
  const leftEdge = Math.max(mapRect.left, getMapObstructionInsets().left) + LABEL_GAP;
  const rightRoom = Math.max(0, rightEdge - pinRect.right);
  const leftRoom = Math.max(0, pinRect.left - leftEdge);
  const desiredWidth = Math.min(LABEL_MAX_WIDTH, Math.max(label.scrollWidth, labelRect.width));
  const useLeft = rightRoom < desiredWidth && leftRoom > rightRoom;
  const previousFit = [container.style.left, container.style.right, label.style.maxWidth].join(";");
  container.style.left = useLeft ? "auto" : LABEL_OFFSET;
  container.style.right = useLeft ? LABEL_OFFSET : "auto";
  label.style.maxWidth = `${Math.min(LABEL_MAX_WIDTH, useLeft ? leftRoom : rightRoom)}px`;
  if (previousFit !== [container.style.left, container.style.right, label.style.maxWidth].join(";"))
    map.triggerRepaint();
}

/**
 * Renders a teardrop pin marker on the map at `coords` (red by default).
 * Pass `null` to remove the marker. Reuses the same marker instance
 * when coords/label change to avoid flickering.
 */
export function usePinMarker(
  coords: LngLat | null,
  label: string,
  showLabel = true,
  color: PinColor = PIN_RED,
  onActivate?: () => void,
  contributors: readonly Attribution[] = NO_CONTRIBUTORS,
  /** Native field-aware callers supply name receipts separately; undefined preserves legacy root ownership. */
  labelContributors?: readonly Attribution[],
) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const receiptKey = serializeContributors(contributors);
  const labelReceiptKey = serializeContributors(labelContributors ?? []);
  const separateChannels = labelContributors !== undefined;
  const [markerEvidence, setMarkerEvidence] = useState<{
    element: Element | null;
    labelElement: HTMLElement | null;
    receiptKey: string;
    labelReceiptKey: string;
    labelContributors: readonly Attribution[];
    contributors: readonly Attribution[];
  }>({
    element: null,
    labelElement: null,
    receiptKey: "[]",
    labelReceiptKey: "[]",
    labelContributors: [],
    contributors: [],
  });
  useMarkerMapAttributions("pin-marker", markerEvidence.element, markerEvidence.contributors);
  useMarkerMapAttributions(
    "pin-label",
    markerEvidence.labelElement,
    markerEvidence.labelContributors,
    "text",
  );
  const geometryRef = useRef<SVGSVGElement | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const markerMapRef = useRef<maplibregl.Map | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const labelContainerRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const scheduleLabelFitRef = useRef<() => void>(() => undefined);
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  // biome-ignore lint/correctness/useExhaustiveDependencies: styleVersion announces a replacement map while mapRef keeps stable identity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !showLabel) return;
    let frame = 0;
    let controlsMoving = false;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const pin = elementRef.current;
        const container = labelContainerRef.current;
        const labelEl = labelRef.current;
        if (pin && container && labelEl) fitPinLabel(map, pin, container, labelEl);
        if (controlsMoving) schedule();
      });
    };
    scheduleLabelFitRef.current = schedule;
    map.on("move", schedule);
    map.on("resize", schedule);
    window.addEventListener("resize", schedule);
    const unsubscribeObstructions = subscribeMapObstructions(schedule);
    const controls = document.querySelector<HTMLElement>("[data-map-controls-columns]");
    const controlsObserver =
      controls && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    const onControlsTransitionStart = (event: TransitionEvent) => {
      if (event.propertyName !== "bottom") return;
      controlsMoving = true;
      schedule();
    };
    const onControlsTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "bottom") return;
      controlsMoving = false;
      schedule();
    };
    if (controls) {
      controlsObserver?.observe(controls);
      controls.addEventListener("transitionstart", onControlsTransitionStart);
      controls.addEventListener("transitionend", onControlsTransitionEnd);
      controls.addEventListener("transitioncancel", onControlsTransitionEnd);
    }
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      map.off("move", schedule);
      map.off("resize", schedule);
      window.removeEventListener("resize", schedule);
      unsubscribeObstructions();
      controlsObserver?.disconnect();
      controls?.removeEventListener("transitionstart", onControlsTransitionStart);
      controls?.removeEventListener("transitionend", onControlsTransitionEnd);
      controls?.removeEventListener("transitioncancel", onControlsTransitionEnd);
      scheduleLabelFitRef.current = () => undefined;
    };
  }, [mapRef, mapReady, showLabel, styleVersion]);

  // Remove marker on unmount
  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      markerMapRef.current = null;
      elementRef.current = null;
      labelContainerRef.current = null;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mapReady is an intentional trigger so the marker is created once the map initializes
  useEffect(() => {
    if (!coords) {
      markerRef.current?.remove();
      markerRef.current = null;
      markerMapRef.current = null;
      elementRef.current = null;
      labelContainerRef.current = null;
      setMarkerEvidence((current) =>
        current.element === null
          ? current
          : {
              element: null,
              labelElement: null,
              receiptKey: "[]",
              labelReceiptKey: "[]",
              labelContributors: [],
              contributors: [],
            },
      );
      return;
    }

    const captured = readCapturedContributors(receiptKey) ?? [];
    const capturedLabel = readCapturedContributors(labelReceiptKey) ?? [];
    const publishMarkerEvidence = (root: HTMLElement) => {
      const element = separateChannels ? geometryRef.current : root;
      const labelElement = separateChannels && showLabel ? labelRef.current : null;
      setMarkerEvidence((current) =>
        current.element === element &&
        current.labelElement === labelElement &&
        current.receiptKey === receiptKey &&
        current.labelReceiptKey === labelReceiptKey
          ? current
          : {
              element,
              labelElement,
              receiptKey,
              labelReceiptKey,
              contributors: captured,
              labelContributors: capturedLabel,
            },
      );
    };
    let destroyed = false;

    void import("maplibre-gl")
      .then((maplibregl) => {
        if (destroyed || !mapRef.current) return;

        // Move and relabel existing marker instead of recreating
        if (markerRef.current && markerMapRef.current !== mapRef.current) {
          markerRef.current.remove();
          markerRef.current = null;
        }
        if (markerRef.current) {
          markerRef.current.setLngLat(coords);
          if (labelRef.current) labelRef.current.textContent = label;
          if (elementRef.current) {
            if (onActivate) {
              elementRef.current.setAttribute("role", "button");
              elementRef.current.dataset.openmapxPinMarker = "";
              elementRef.current.tabIndex = 0;
              elementRef.current.setAttribute("aria-label", label);
            } else {
              elementRef.current.removeAttribute("role");
              delete elementRef.current.dataset.openmapxPinMarker;
              elementRef.current.removeAttribute("tabindex");
              elementRef.current.removeAttribute("aria-label");
            }
          }
          if (labelContainerRef.current) {
            if (showLabel && elementRef.current && !labelContainerRef.current.isConnected)
              elementRef.current.appendChild(labelContainerRef.current);
            if (!showLabel) labelContainerRef.current.remove();
            labelContainerRef.current.style.pointerEvents = onActivate ? "auto" : "none";
            labelContainerRef.current.style.cursor = onActivate ? "pointer" : "";
          }
          if (elementRef.current) publishMarkerEvidence(elementRef.current);
          scheduleLabelFitRef.current();
          return;
        }

        const el = document.createElement("div");
        el.style.cssText = "cursor:pointer;";
        if (onActivate) {
          el.dataset.openmapxPinMarker = "";
          el.setAttribute("role", "button");
          el.tabIndex = 0;
          el.setAttribute("aria-label", label);
        }
        // Without an action the pin is see-through: a hover pin drawn over a
        // feature still lets that feature take the click.
        bindMapMarkerActivation(el, {
          onActivate: () => onActivateRef.current?.(),
          isEnabled: () => Boolean(onActivateRef.current),
        });

        const svgDiv = document.createElement("div");
        svgDiv.style.cssText = "transform-origin:bottom center;";
        svgDiv.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="32" viewBox="0 0 27 43">
          <path d="M13.5 0C6.044 0 0 6.044 0 13.5c0 9.219 13.5 29.5 13.5 29.5S27 22.719 27 13.5C27 6.044 20.956 0 13.5 0z"
                fill="${color.fill}" stroke="${color.stroke}" stroke-width="1"/>
          <circle cx="13.5" cy="13.5" r="5.5" fill="white"/>
        </svg>
      `;

        const labelContainer = document.createElement("div");
        labelContainer.style.cssText = `position:absolute;left:${LABEL_OFFSET};top:0;bottom:0;display:flex;align-items:center;pointer-events:${onActivate ? "auto" : "none"};${onActivate ? "cursor:pointer;" : ""}`;

        const labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        labelSpan.style.cssText = [
          "white-space:nowrap",
          "max-width:200px",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "font-size:14px",
          "font-weight:700",
          "color:#B81C16",
          "text-shadow:0 1px 2px rgba(255,255,255,0.9),0 0 4px rgba(255,255,255,0.7)",
          "font-family:'Plus Jakarta Sans Variable',Arial,sans-serif",
        ].join(";");

        geometryRef.current = svgDiv.querySelector("svg");
        labelRef.current = labelSpan;
        labelContainerRef.current = labelContainer;
        elementRef.current = el;
        labelContainer.appendChild(labelSpan);
        el.appendChild(svgDiv);
        if (showLabel) el.appendChild(labelContainer);

        markerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat(coords)
          .addTo(mapRef.current);
        markerMapRef.current = mapRef.current;
        publishMarkerEvidence(el);
        scheduleLabelFitRef.current();
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
    };
  }, [
    coords,
    label,
    mapRef,
    mapReady,
    styleVersion,
    showLabel,
    color,
    onActivate,
    receiptKey,
    labelReceiptKey,
    separateChannels,
  ]);
}
