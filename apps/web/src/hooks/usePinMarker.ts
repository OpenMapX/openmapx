"use client";

import type { LngLat } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { getMapObstructionInsets, subscribeMapObstructions } from "@/lib/mapObstructions";

interface PinColor {
  fill: string;
  stroke: string;
}

const PIN_RED: PinColor = { fill: "#EA4335", stroke: "#C5221F" };
const LABEL_MAX_WIDTH = 200;
const LABEL_GAP = 8;

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
  container.style.left = useLeft ? "auto" : "20px";
  container.style.right = useLeft ? "20px" : "auto";
  label.style.maxWidth = `${Math.min(LABEL_MAX_WIDTH, useLeft ? leftRoom : rightRoom)}px`;
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
) {
  const { mapRef, mapReady, styleVersion } = useMap();
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
      return;
    }

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
            labelContainerRef.current.style.pointerEvents = onActivate ? "auto" : "none";
            labelContainerRef.current.style.cursor = onActivate ? "pointer" : "";
          }
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
        el.addEventListener("click", (event) => {
          if (getMapClickOwner(event)) return;
          if (!onActivateRef.current) return;
          event.stopPropagation();
          onActivateRef.current();
        });
        el.addEventListener("keydown", (event) => {
          if (!onActivateRef.current || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          event.stopPropagation();
          onActivateRef.current();
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
        labelContainer.style.cssText = `position:absolute;left:20px;top:0;bottom:0;display:flex;align-items:center;pointer-events:${onActivate ? "auto" : "none"};${onActivate ? "cursor:pointer;" : ""}`;

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
        scheduleLabelFitRef.current();
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
    };
  }, [coords, label, mapRef, mapReady, styleVersion, showLabel, color, onActivate]);
}
