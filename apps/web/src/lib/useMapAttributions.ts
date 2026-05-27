"use client";

import { escapeHtml, sanitizeUrl } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect, useRef } from "react";
import { useMap } from "./MapContext";

/**
 * Per-layer attribution registration that feeds MapLibre's built-in
 * AttributionControl. Each `Attribution` entry becomes its OWN MapLibre
 * source (with a no-paint stub layer to satisfy the control's `used` check),
 * so MapLibre's substring dedup collapses identical credits naturally
 * regardless of which layer contributed them.
 *
 * Why one source per Attribution and not one source per layer: MapLibre's
 * `source.attribution` is a single string per source, and its dedup compares
 * strings via `includes()`. If a layer bundles "vendor + OSM" into one
 * source attribution string and another does the same with a different
 * vendor, the two strings don't include each other and OSM ends up shown
 * twice. Atomic per-entry strings let dedup do its job.
 *
 * Source ids are scoped by `layerKey` so layers don't tear down each other's
 * contributions when one unmounts. The delimiter between layerKey and
 * sourceId is a control character that neither input can contain in
 * practice, so distinct (layerKey, sourceId) pairs always produce distinct
 * source ids.
 */
const PREFIX = "attr";
// A pipe is allowed in MapLibre source ids and is not used in any caller-
// supplied layerKey or Attribution.sourceId across the codebase (those follow
// the integration manifest `[a-z0-9-]+` slug convention). Picking a
// delimiter outside that vocabulary makes the (layerKey, sourceId) →
// source-id mapping collision-safe.
const DELIMITER = "|";

function srcId(layerKey: string, sourceId: string): string {
  return `${PREFIX}${DELIMITER}${layerKey}${DELIMITER}${sourceId}`;
}

/**
 * Allow `<a>` elements with `href`/`target`/`rel`/`title`; strip everything
 * else (other tags are unwrapped to text, all other attributes are dropped,
 * scripts and event handlers are removed by the HTML parser since DOMParser
 * does not execute them). Used for the verbatim `attributionText` field,
 * which by manifest convention may embed working anchors (the license-
 * required publisher link).
 *
 * Runs in the client only — `useMapAttributions` invokes it inside an
 * effect, so `DOMParser` is defined.
 */
function sanitizeAttributionHtml(html: string): string {
  if (typeof DOMParser === "undefined") return escapeHtml(html);
  // DOMParser is inert: it parses without executing scripts or fetching
  // resources, which is exactly the safety property we need before the
  // allowlist walk.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  const walk = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.parentNode?.removeChild(child);
        continue;
      }
      const el = child as HTMLElement;
      if (el.tagName.toLowerCase() === "a") {
        const rawHref = el.getAttribute("href") ?? "";
        const safeHref = /^https?:\/\//i.test(rawHref) ? rawHref : "";
        if (!safeHref) {
          while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el);
          el.parentNode?.removeChild(el);
          continue;
        }
        const title = el.getAttribute("title");
        const target = el.getAttribute("target") === "_self" ? "_self" : "_blank";
        for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
        el.setAttribute("href", safeHref);
        el.setAttribute("target", target);
        el.setAttribute("rel", "noopener noreferrer");
        if (title) el.setAttribute("title", title);
        walk(el);
      } else {
        while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el);
        el.parentNode?.removeChild(el);
      }
    }
  };
  walk(root);
  return root.innerHTML;
}

function htmlFor(attr: Attribution): string {
  // `attributionText` is the license-required verbatim wording. The manifest
  // convention (see integrations/*/manifest.json) embeds working `<a>` links
  // in this field, so render it as sanitized HTML rather than escaping it
  // into literal markup. When only `name` is provided, fall back to the
  // escape-and-wrap path that builds an anchor from `attr.url`.
  if (attr.attributionText) {
    return sanitizeAttributionHtml(attr.attributionText);
  }
  // Keep a leading "© " outside the anchor. Every manifest-authored credit
  // uses the "© <a>Publisher</a>" form; if we left "©" inside the anchor
  // here, the resulting HTML wouldn't `includes()` (or be included by) the
  // manifest form, and MapLibre's substring dedup would render the same
  // credit twice when a base layer and an overlay both register it. The
  // fallback also has to match the post-sanitization attribute order
  // (`target="_blank" rel="noopener noreferrer"`) for the same reason.
  const hasCopyright = attr.name.startsWith("© ");
  const inner = hasCopyright ? attr.name.slice(2) : attr.name;
  const escapedInner = escapeHtml(inner);
  if (attr.url) {
    const safeUrl = sanitizeUrl(attr.url);
    if (safeUrl) {
      const anchor = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapedInner}</a>`;
      return hasCopyright ? `© ${anchor}` : anchor;
    }
  }
  return escapeHtml(attr.name);
}

export function useMapAttributions(layerKey: string, attributions: Attribution[]): void {
  const { mapRef, mapReady, styleVersion } = useMap();

  // Track the source ids and the attribution html we last applied for this
  // layer key. Lets `sync` decide what to add/update/remove without ever
  // calling `map.getStyle()` (which deep-clones the entire style spec).
  const ownedRef = useRef<Map<string, string>>(new Map());
  // Identifies the currently-active effect run. A deferred `tearDown`
  // captures the symbol that was current when its cleanup queued it and
  // checks this ref on fire — if a newer effect has taken ownership of the
  // same layerKey (deps changed before `style.load` fired), the deferred
  // tearDown is no-ops and the newer effect's `sync` keeps managing the
  // sources. Prevents a race where the deferred teardown wipes sources the
  // new effect just registered.
  const ownerRef = useRef<symbol | null>(null);

  // Equality key over the parts that actually drive the rendered HTML, so
  // identical contents across renders don't trigger source churn. Includes
  // every field htmlFor reads, so changes to license-required `attributionText`
  // re-run the effect.
  const memoKey = attributions
    .map((a) => `${a.sourceId}|${a.url ?? ""}|${a.name}|${a.attributionText ?? ""}`)
    .join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: memoKey captures attributions
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const owned = ownedRef.current;
    const me = Symbol("useMapAttributions");
    ownerRef.current = me;

    // Cancellation flag captured by every `sync` and `idle` callback this
    // effect run schedules — `cancelled` flips on cleanup, so callbacks that
    // fire after cleanup (notably `once("idle", sync)` we cannot off()) bail
    // out instead of mutating shared state.
    let cancelled = false;

    const removeOwned = (sid: string) => {
      const lid = `${sid}-stub`;
      if (map.getLayer(lid)) map.removeLayer(lid);
      if (map.getSource(sid)) map.removeSource(sid);
      owned.delete(sid);
    };

    const sync = () => {
      if (cancelled) return;
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }

      // Wanted source ids for this render.
      const wanted = new Map<string, string>(); // sid -> html
      for (const attr of attributions) {
        wanted.set(srcId(layerKey, attr.sourceId), htmlFor(attr));
      }

      // Remove anything we own but no longer want.
      for (const sid of owned.keys()) {
        if (!wanted.has(sid)) removeOwned(sid);
      }

      // Add or refresh wanted sources. Guard each add against the real
      // MapLibre state (not just `owned`) — `owned` and the map can diverge
      // across style swaps, HMR retains, and orphaned `idle` callbacks.
      for (const [sid, html] of wanted) {
        if (owned.get(sid) === html && map.getSource(sid)) continue;
        if (map.getSource(sid)) removeOwned(sid);
        map.addSource(sid, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          attribution: html,
        });
        // No-paint stub layer — MapLibre's AttributionControl only counts
        // sources whose TileManager is marked `used`, which requires at
        // least one layer to reference the source.
        const lid = `${sid}-stub`;
        if (!map.getLayer(lid)) {
          map.addLayer({
            id: lid,
            type: "circle",
            source: sid,
            paint: { "circle-radius": 0, "circle-opacity": 0 },
          });
        }
        owned.set(sid, html);
      }
    };

    sync();
    map.on("styledata", sync);
    return () => {
      cancelled = true;
      map.off("styledata", sync);
      // Snapshot the sids this effect run is responsible for. If the style
      // isn't loaded right now, queue the teardown for the next `style.load`
      // so we don't leave orphan sources behind across a style swap. The
      // `ownerRef` check at fire time is what makes the deferred case safe:
      // if a newer effect has taken ownership of this layerKey before
      // `style.load` fires, the deferred tearDown skips — the newer effect
      // is now managing these sources via its own `sync`.
      const mySnapshot = [...owned.keys()];
      const tearDown = () => {
        if (ownerRef.current !== me) return;
        for (const sid of mySnapshot) {
          const lid = `${sid}-stub`;
          if (map.getLayer(lid)) map.removeLayer(lid);
          if (map.getSource(sid)) map.removeSource(sid);
          owned.delete(sid);
        }
        if (ownerRef.current === me) ownerRef.current = null;
      };
      if (map.isStyleLoaded()) {
        tearDown();
      } else {
        map.once("style.load", tearDown);
      }
    };
  }, [layerKey, memoKey, mapReady, styleVersion, mapRef]);
}
