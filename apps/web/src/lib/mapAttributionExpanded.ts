"use client";

import { useEffect, useSyncExternalStore } from "react";

const EXPANDED_CLASS = "maplibregl-compact-show";
const ATTRIB_SELECTOR = ".maplibregl-ctrl-attrib.maplibregl-compact";

let expanded = false;
const listeners = new Set<() => void>();

function setExpanded(value: boolean) {
  if (expanded === value) return;
  expanded = value;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => expanded;
const getServerSnapshot = () => false;

/** True when the user has tapped MapLibre's "i" button to expand attribution. */
export function useMapAttributionExpanded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Wires MapLibre's attribution element to the store. The control is created
 * lazily when the map mounts, so we poll briefly until it appears, then watch
 * its `class` attribute for the `maplibregl-compact-show` toggle.
 *
 * Mount once (e.g., from the page root) — subsequent calls noop.
 */
export function useMapAttributionExpandedObserver() {
  useEffect(() => {
    let attribObserver: MutationObserver | null = null;
    let bodyObserver: MutationObserver | null = null;

    const attach = (el: Element) => {
      const update = () => setExpanded(el.classList.contains(EXPANDED_CLASS));
      update();
      attribObserver = new MutationObserver(update);
      attribObserver.observe(el, { attributes: true, attributeFilter: ["class"] });
    };

    const existing = document.querySelector(ATTRIB_SELECTOR);
    if (existing) {
      attach(existing);
    } else {
      // Map mounts asynchronously — watch for the attribution element.
      bodyObserver = new MutationObserver(() => {
        const el = document.querySelector(ATTRIB_SELECTOR);
        if (el) {
          bodyObserver?.disconnect();
          bodyObserver = null;
          attach(el);
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      attribObserver?.disconnect();
      bodyObserver?.disconnect();
      setExpanded(false);
    };
  }, []);
}
