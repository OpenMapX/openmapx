"use client";

import { escapeHtml, sanitizeUrl } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect } from "react";
import { useMapAttributionStore } from "./mapAttributionStore";

/**
 * Per-layer attribution registration. Each `Attribution` becomes its own
 * atomic HTML entry in the shared attribution registry (see
 * `mapAttributionStore`), which `<MapFooter>` renders bottom-right alongside
 * the legal links.
 *
 * Why one entry per Attribution and not one bundled string per layer: dedup
 * compares entries via `includes()`. If a layer bundled "vendor + OSM" into
 * one string and another did the same with a different vendor, the two
 * strings wouldn't include each other and OSM would end up shown twice.
 * Atomic per-entry strings let dedup do its job.
 *
 * Entries are scoped by `layerKey` so layers don't tear down each other's
 * contributions when one unmounts.
 */

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
  // manifest form, and the substring dedup would render the same credit
  // twice when a base layer and an overlay both register it. The
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
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);

  // Equality key over the parts that actually drive the rendered HTML, so
  // identical contents across renders don't re-register. Includes every field
  // htmlFor reads, so changes to license-required `attributionText` re-run the
  // effect.
  const memoKey = attributions
    .map((a) => `${a.sourceId}|${a.url ?? ""}|${a.name}|${a.attributionText ?? ""}`)
    .join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: memoKey captures attributions
  useEffect(() => {
    // htmlFor sanitizes via DOMParser, so it has to run client-side — inside
    // the effect, never during render.
    setLayer(layerKey, attributions.map(htmlFor));
    return () => clearLayer(layerKey);
  }, [layerKey, memoKey, setLayer, clearLayer]);
}
