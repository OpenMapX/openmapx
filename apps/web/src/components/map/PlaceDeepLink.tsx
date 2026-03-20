"use client";

import { PANEL, usePlaceStore, useSearchStore, useSidebarStore } from "@openmapx/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";

/**
 * Reads ?place=&lat=&lng=&name= query params on first render and opens
 * the corresponding place panel, then removes the params from the URL.
 */
export function PlaceDeepLink() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { setSelectedPlace } = usePlaceStore();
  const { setQuery } = useSearchStore();
  const { flyTo } = useMap();

  useEffect(() => {
    const id = searchParams.get("place");
    const lat = Number(searchParams.get("lat"));
    const lng = Number(searchParams.get("lng"));
    const name = searchParams.get("name") ?? "";
    const category = searchParams.get("category") ?? undefined;
    const rawCategory = searchParams.get("rawCategory") ?? undefined;

    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const coordinates: [number, number] = [lng, lat];
    flyTo(coordinates);
    setSelectedPlace({ id, name, address: name, coordinates, category, rawCategory });
    useSidebarStore.getState().openSidebar(PANEL.PLACE);
    setQuery(name);

    // Remove deep-link params without adding a history entry
    router.replace("/", { scroll: false });
  }, [flyTo, router, searchParams, setQuery, setSelectedPlace]);

  return null;
}
