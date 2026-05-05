"use client";

import { PANEL, useDirectionsStore, useSearchStore, useSidebarStore } from "@openmapx/core";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

// SearchBar isn't a panel — it's a floating bar driven by useSearchStore.
// Setting `isFocused: true` makes the dropdown open as if the user tapped it.

/**
 * Handles incoming intents from PWA features:
 *
 * - `?q=<query>` — Web Share Target dispatched via /share or shortcut
 * - `?geo=<URI>` — `geo:` protocol handler (RFC 5870)
 * - `?action=search|directions` — manifest shortcuts
 *
 * The corresponding params are consumed once on mount and stripped from the
 * URL so they don't leak into the deep-link state encoded by DeepLinkManager.
 */
export function ShareIntentHandler() {
  const params = useSearchParams();
  // Track the last param signature we already consumed so a re-share while the
  // app is open (subsequent /share redirect, geo: protocol launch, or shortcut)
  // is processed instead of being ignored. A boolean would lock the handler
  // out permanently after the first effect run.
  const lastHandledRef = useRef<string | null>(null);

  useEffect(() => {
    const q = params.get("q");
    const geo = params.get("geo");
    const action = params.get("action");

    if (!q && !geo && !action) {
      // After we strip params, the effect re-fires with an empty query. Clear
      // the dedup signature here so a future re-share of the *same* values is
      // processed instead of being silently dropped.
      lastHandledRef.current = null;
      return;
    }

    const signature = `q=${q ?? ""}|geo=${geo ?? ""}|action=${action ?? ""}`;
    if (lastHandledRef.current === signature) return;
    lastHandledRef.current = signature;

    let query: string | null = null;
    if (q) query = q;
    else if (geo) query = parseGeoUri(geo);

    if (query) {
      useSearchStore.getState().setQuery(query);
      useSearchStore.getState().setIsFocused(true);
    }

    if (action === "directions" || (geo && !query)) {
      useDirectionsStore.getState().open();
      useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
    } else if (action === "search" && !query) {
      useSearchStore.getState().setIsFocused(true);
    }

    // Strip the consumed params from the URL.
    const url = new URL(window.location.href);
    for (const key of ["q", "geo", "action"]) url.searchParams.delete(key);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [params]);

  return null;
}

/**
 * Parses a `geo:` URI per RFC 5870 (e.g. `geo:48.137,11.575?q=Marienplatz`)
 * and extracts a usable text query: `q` param if present, else the
 * "lat,lng" pair as plain text the search engine can geocode.
 */
function parseGeoUri(raw: string): string | null {
  let value = raw;
  // Some platforms URL-encode the whole URI; double-decode safely.
  try {
    if (value.includes("%3A") || value.includes("%2C")) value = decodeURIComponent(value);
  } catch {
    // ignore
  }

  if (!value.startsWith("geo:")) {
    // Plain text "geo" param — treat as a search query.
    return value;
  }

  const body = value.slice(4);
  const [coords, rest] = body.split("?");
  if (rest) {
    const inner = new URLSearchParams(rest);
    const q = inner.get("q");
    if (q) return q;
  }
  const [lat, lng] = coords.split(",");
  if (lat && lng) return `${lat},${lng}`;
  return null;
}
