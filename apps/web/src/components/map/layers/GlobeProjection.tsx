"use client";

import { useLayerStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";

type SkySpecification = Parameters<maplibregl.Map["setSky"]>[0];

const DEFAULT_SKY: SkySpecification = {
  "sky-color": "#88C6FC",
  "horizon-color": "#d6e8f7",
  "fog-color": "#ffffff",
  "sky-horizon-blend": 0.5,
  "horizon-fog-blend": 0.4,
  "fog-ground-blend": 0.1,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 0.6, 8, 0.25, 11, 0],
};

const SATELLITE_SKY: SkySpecification = {
  "sky-color": "#0a0a2e",
  "horizon-color": "#1a3a5e",
  "fog-color": "#000000",
  "sky-horizon-blend": 0.7,
  "horizon-fog-blend": 0.3,
  "fog-ground-blend": 0,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.95, 5, 0.95, 8, 0],
};

const DEFAULT_BG = "#d6e8f7";

const ZOOM_OUT_THRESHOLD = 11;
const ZOOM_OUT_TARGET = 3;
const ZOOM_OUT_DURATION = 1500;

const TILE = 512;
// Reverse parallax: stars move opposite to the globe drag so it feels like
// a camera orbiting a ball in space. Large coprime multipliers ensure the
// two layers never re-align, so every viewing angle has a unique starfield.
const PARALLAX_NEAR = 5;
const PARALLAX_FAR = 8;

function getSky(activeLayer: string): SkySpecification {
  return activeLayer === "satellite" ? SATELLITE_SKY : DEFAULT_SKY;
}

function makeRng(initialSeed: number) {
  let s = initialSeed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function renderStarTile(
  seed: number,
  dimCount: number,
  medCount: number,
  brightCount: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const rand = makeRng(seed);

  for (let i = 0; i < dimCount; i++) {
    const x = rand() * TILE;
    const y = rand() * TILE;
    ctx.beginPath();
    ctx.arc(x, y, 0.3 + rand() * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.12 + rand() * 0.3})`;
    ctx.fill();
  }

  for (let i = 0; i < medCount; i++) {
    const x = rand() * TILE;
    const y = rand() * TILE;
    const hue = rand() < 0.3 ? 220 : rand() < 0.5 ? 40 : 0;
    const sat = hue === 0 ? 0 : 20 + rand() * 30;
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + rand() * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue},${sat}%,${70 + rand() * 30}%,${0.5 + rand() * 0.4})`;
    ctx.fill();
  }

  for (let i = 0; i < brightCount; i++) {
    const x = rand() * TILE;
    const y = rand() * TILE;
    const r = 1 + rand() * 1.2;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    glow.addColorStop(0, "rgba(255,255,255,0.9)");
    glow.addColorStop(0.3, "rgba(200,220,255,0.3)");
    glow.addColorStop(1, "rgba(200,220,255,0)");
    ctx.beginPath();
    ctx.arc(x, y, r * 3, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
  }

  return canvas.toDataURL("image/png");
}

let tileUrls: [string, string] | null = null;
function getTileUrls(): [string, string] {
  if (tileUrls) return tileUrls;
  tileUrls = [renderStarTile(42, 500, 100, 12), renderStarTile(137, 400, 80, 8)];
  return tileUrls;
}

function applySpaceBackground(container: HTMLElement, lng: number, lat: number) {
  const [near, far] = getTileUrls();
  const lngNorm = (lng + 180) / 360;
  const latNorm = (90 - lat) / 180;

  // Reverse direction: when globe rotates right (lng increases) stars
  // drift slightly left, like a ball spinning inside a fixed universe.
  const nearX = lngNorm * TILE * PARALLAX_NEAR;
  const nearY = latNorm * TILE * PARALLAX_NEAR;
  const farX = lngNorm * TILE * PARALLAX_FAR;
  const farY = latNorm * TILE * PARALLAX_FAR;

  // Nebula clouds traverse the full viewport — opposite side of the
  // earth shows completely different nebulae (reversed direction).
  const nLng = (1 - lngNorm) * 100;
  const nLat = (1 - latNorm) * 100;

  container.style.backgroundImage = [
    `radial-gradient(ellipse 700px 500px at ${nLng}% ${nLat}%, rgba(40,15,90,0.55) 0%, transparent 70%)`,
    `radial-gradient(ellipse 600px 400px at ${100 - nLng}% ${100 - nLat}%, rgba(15,40,100,0.45) 0%, transparent 70%)`,
    `radial-gradient(ellipse 500px 350px at ${(nLng + 30) % 100}% ${(nLat + 25) % 100}%, rgba(80,15,50,0.35) 0%, transparent 70%)`,
    `url("${near}")`,
    `url("${far}")`,
  ].join(",");
  container.style.backgroundColor = "#050510";
  container.style.backgroundRepeat = "no-repeat,no-repeat,no-repeat,repeat,repeat";
  container.style.backgroundPosition = [
    "0 0",
    "0 0",
    "0 0",
    `${nearX}px ${nearY}px`,
    `${farX}px ${farY}px`,
  ].join(",");
}

function clearBackground(container: HTMLElement) {
  container.style.backgroundImage = "";
  container.style.backgroundColor = "";
  container.style.backgroundRepeat = "";
  container.style.backgroundPosition = "";
  container.style.background = "";
}

export function GlobeProjection() {
  const { mapRef, mapReady } = useMap();
  const globeView = useLayerStore((s) => s.globeView);
  const activeLayer = useLayerStore((s) => s.activeLayer);
  // Initialise to false so the zoom-out animation also triggers on page
  // reload when globeView was persisted — otherwise the map would start at
  // a high zoom (e.g. geolocation zoom 14) where the globe preset already
  // blends to flat mercator and the user wouldn't see the globe.
  const prevGlobeRef = useRef(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const container = map.getContainer();
    const isSatelliteGlobe = globeView && activeLayer === "satellite";

    const applyBg = () => {
      if (!globeView) {
        clearBackground(container);
        return;
      }
      if (isSatelliteGlobe) {
        const c = map.getCenter();
        applySpaceBackground(container, c.lng, c.lat);
      } else {
        clearBackground(container);
        container.style.background = DEFAULT_BG;
      }
    };

    const apply = () => {
      if (globeView) {
        map.setProjection({ type: "globe" });
        map.setSky(getSky(activeLayer));
      } else {
        map.setProjection({ type: "mercator" });
        map.setSky({ "atmosphere-blend": 0 });
      }
      applyBg();
    };

    // Initial application: the map's "load" event guarantees the style is
    // ready, so apply() can be called without a guard from that callback.
    // When already loaded we can apply directly.
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once("load", apply);
    }

    // Re-apply after style reloads (e.g. base-layer switch resets projection).
    const onStyleData = () => {
      if (map.isStyleLoaded()) apply();
    };
    map.on("styledata", onStyleData);

    // Parallax: shift the starfield as the user rotates the globe
    const onMove = isSatelliteGlobe
      ? () => {
          const c = map.getCenter();
          applySpaceBackground(container, c.lng, c.lat);
        }
      : null;
    if (onMove) map.on("move", onMove);

    return () => {
      map.off("load", apply);
      map.off("styledata", onStyleData);
      if (onMove) map.off("move", onMove);
      clearBackground(container);
    };
  }, [globeView, activeLayer, mapReady, mapRef]);

  // Zoom out to showcase the globe when toggling on from a zoomed-in view
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const justEnabled = globeView && !prevGlobeRef.current;
    prevGlobeRef.current = globeView;

    if (!justEnabled) return;
    if (map.getZoom() <= ZOOM_OUT_THRESHOLD) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      map.jumpTo({ zoom: ZOOM_OUT_TARGET });
    } else {
      map.easeTo({ zoom: ZOOM_OUT_TARGET, duration: ZOOM_OUT_DURATION });
    }
  }, [globeView, mapReady, mapRef]);

  return null;
}
