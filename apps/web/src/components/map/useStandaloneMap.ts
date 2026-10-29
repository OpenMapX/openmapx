"use client";

import { useColorScheme } from "@mui/material/styles";
import type * as maplibregl from "maplibre-gl";
import { type DependencyList, type RefObject, useCallback, useEffect, useRef } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
import { loadMapLibreRuntime, type MapLibreRuntime } from "@/lib/maplibreRuntime";

export type StandaloneMapStyle = string | maplibregl.StyleSpecification;

export interface StandaloneMapDefinition {
  /** Resolve the stylesheet once the MapLibre runtime has loaded. */
  loadStyle: (runtime: MapLibreRuntime) => Promise<StandaloneMapStyle>;
  options?: Omit<maplibregl.MapOptions, "container" | "style">;
  /**
   * Install behaviour on the new map. The returned cleanup runs before the map
   * is removed. Layers belong in a `subscribeStyleLoaded` callback: the style
   * is still being parsed when this runs.
   */
  setup?: (map: maplibregl.Map) => (() => void) | undefined;
}

/**
 * Own a MapLibre instance that is separate from the shared app map, such as
 * the offline area picker or the public share page. It has no layer stack or
 * `MapContext`; construction waits for the runtime and stylesheet, and a
 * definition change or unmount during that wait discards the result.
 *
 * Credits are rendered by the caller through `<MapCredits>`, so MapLibre's
 * attribution control is disabled.
 *
 * Returns a ref to the current map, which is `null` until construction completes.
 */
export function useStandaloneMap(
  containerRef: RefObject<HTMLElement | null>,
  define: () => StandaloneMapDefinition | null,
  deps: DependencyList,
): RefObject<maplibregl.Map | null> {
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    const definition = define();
    if (!definition) return;
    let destroyed = false;
    let map: maplibregl.Map | undefined;
    let cleanup: (() => void) | undefined;

    const init = async () => {
      const runtime = await loadMapLibreRuntime();
      if (destroyed) return;
      const style = await definition.loadStyle(runtime);
      const container = containerRef.current;
      if (destroyed || !container) return;
      map = new runtime.Map({
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
        ...definition.options,
        container,
        style,
      });
      mapRef.current = map;
      cleanup = definition.setup?.(map);
    };

    // A failed style fetch leaves the container empty rather than raising an
    // unhandled rejection; the surrounding page remains usable.
    void init().catch(() => {});

    return () => {
      destroyed = true;
      cleanup?.();
      map?.remove();
      mapRef.current = null;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller supplies the dependencies of `define`, mirroring useEffect
  }, deps);

  return mapRef;
}

/** The colour-scheme variant a standalone map renders its basemap in. */
export function useStandaloneMapVariant(): "light" | "dark" {
  const { mode, systemMode } = useColorScheme();
  return (mode === "system" ? systemMode : mode) === "dark" ? "dark" : "light";
}

/**
 * Load the configured light or dark basemap. The loader identity changes only
 * with the environment or colour scheme, so it can be a map dependency.
 */
export function useStandaloneBasemapStyle(): () => Promise<StandaloneMapStyle> {
  const env = useEnv();
  const variant = useStandaloneMapVariant();
  return useCallback(
    async () =>
      (env.styleProvider === "openmapx"
        ? await loadOpenMapXStyle(env, variant)
        : await loadMaptilerStyle(
            variant === "dark" ? "streets-v2-dark" : "bright-v2",
            env,
          )) as StandaloneMapStyle,
    [env, variant],
  );
}
