"use client";

import CloseIcon from "@mui/icons-material/Close";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import {
  formatStreetLevelRef,
  parseStreetLevelRef,
  useDirectionsStore,
  usePlaceStore,
  useStreetLevelStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { LocationMinimap } from "@/integration-api/components/LocationMinimap";
import { useStreetLevelProviders } from "@/integration-api/components/useStreetLevelProviders";
import { useMap } from "@/integration-api/map/MapContext";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { StreetLevelFlatImage } from "./StreetLevelFlatImage";
import { StreetLevelInfoCard } from "./StreetLevelInfoCard";
import { fetchStreetLevelNode, pickPanoramaUrl, type StreetLevelNode } from "./useStreetLevelNode";

interface TourPlugin {
  setCurrentNode: (id: string) => void;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
}

export default function StreetLevelViewerInner() {
  const t = useTranslations("streetLevel");
  const tc = useTranslations("common");
  const { apiUrl } = useEnv();
  const activeImage = useStreetLevelStore((s) => s.activeImage);
  const acceptedProviders = useStreetLevelStore((s) => s.acceptedProviders);
  const closeViewer = useStreetLevelStore((s) => s.closeViewer);
  const requestImageLoad = useStreetLevelStore((s) => s.requestImageLoad);
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const { providers } = useStreetLevelProviders();
  const { flyTo } = useMap();

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ destroy: () => void } | null>(null);
  const tourRef = useRef<TourPlugin | null>(null);
  const lastNodeIdRef = useRef<string | null>(null);
  const [node, setNode] = useState<StreetLevelNode | null>(null);
  const [failed, setFailed] = useState(false);

  // The viewer effect must not re-run when these change, so read them through
  // refs rather than dependencies.
  // A provider whose imagery is proxied exposes nothing to a third party and is
  // auto-accepted, so it must not be filtered out of the arrow set merely
  // because the user has not visited it yet.
  const reachableProviders = useMemo(
    () => [
      ...new Set([
        ...acceptedProviders,
        ...providers.filter((p) => p.endUserExposure === "server-only").map((p) => p.id),
      ]),
    ],
    [acceptedProviders, providers],
  );

  const acceptedProvidersRef = useRef(reachableProviders);
  const requestImageLoadRef = useRef(requestImageLoad);
  useEffect(() => {
    acceptedProvidersRef.current = reachableProviders;
    requestImageLoadRef.current = requestImageLoad;
  }, [reachableProviders, requestImageLoad]);

  // A stable string is a safer effect dependency than the ref object, whose
  // identity changes on every parse.
  const activeRefString = activeImage ? formatStreetLevelRef(activeImage) : null;
  const activeRefStringRef = useRef(activeRefString);
  useEffect(() => {
    activeRefStringRef.current = activeRefString;
  }, [activeRefString]);

  const isPano = node?.image.isPano ?? false;

  /**
   * Move the tour to a node, recording it so the store→viewer effect doesn't
   * re-issue the same navigation.
   *
   * On failure — the metadata resolved but the panorama asset 404s or its URL
   * expired — the marker is cleared again. Leaving it set would strand the
   * viewer on the previous image while the store, info card and deep link all
   * describe the new one, with a re-click no-oping because nothing changed.
   */
  const navigateTo = useCallback((tour: TourPlugin, nodeId: string) => {
    lastNodeIdRef.current = nodeId;
    void Promise.resolve(tour.setCurrentNode(nodeId)).catch(() => {
      lastNodeIdRef.current = null;
      setFailed(true);
    });
  }, []);

  // Close when the user picks a place from the in-viewer search bar, but not
  // on initial mount (a place may already be selected when the viewer opens).
  const prevSelectedPlace = useRef(selectedPlace);
  useEffect(() => {
    if (selectedPlace !== prevSelectedPlace.current && selectedPlace !== null) {
      closeViewer();
    }
    prevSelectedPlace.current = selectedPlace;
  }, [selectedPlace, closeViewer]);

  const prevDirectionsOpen = useRef(directionsOpen);
  useEffect(() => {
    if (directionsOpen && !prevDirectionsOpen.current) closeViewer();
    prevDirectionsOpen.current = directionsOpen;
  }, [directionsOpen, closeViewer]);

  // Load the active node's metadata and arrows.
  //
  // Keyed on the ref STRING, not the ref object: `requestImageLoad` allocates a
  // fresh object on every call — including the one fired from `node-changed`
  // after each arrow hop — so depending on identity would refetch a node the
  // plugin just fetched itself, doubling network per hop.
  useEffect(() => {
    const ref = activeRefString ? parseStreetLevelRef(activeRefString) : null;
    if (!ref) return;
    let cancelled = false;

    setFailed(false);
    void fetchStreetLevelNode(apiUrl, ref)
      .then((loaded) => {
        if (!cancelled) setNode(loaded);
      })
      .catch(() => {
        if (cancelled) return;
        setNode(null);
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl, activeRefString]);

  // Build the sphere viewer once. It is deliberately NOT keyed on the current
  // node: the virtual-tour plugin owns navigation after mount, and rebuilding
  // on every hop would destroy the viewer and re-download the panorama.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isPano) return;

    let unmounted = false;

    void (async () => {
      const [{ Viewer }, { VirtualTourPlugin }] = await Promise.all([
        import("@photo-sphere-viewer/core"),
        import("@photo-sphere-viewer/virtual-tour-plugin"),
      ]);
      if (unmounted) return;

      const viewer = new Viewer({
        container,
        navbar: false,
        plugins: [
          [
            VirtualTourPlugin,
            {
              // `dataMode` defaults to "client", which expects a static `nodes`
              // array and ignores `getNode` entirely. Server mode is what makes
              // on-demand, cross-provider resolution work.
              dataMode: "server",
              positionMode: "gps",
              renderMode: "3d",
              getNode: async (nodeId: string) => {
                const ref = parseStreetLevelRef(nodeId);
                if (!ref) throw new Error(`Malformed street-level-imagery node id: ${nodeId}`);
                const target = await fetchStreetLevelNode(apiUrl, ref);

                return {
                  id: target.id,
                  panorama: pickPanoramaUrl(target.image.assets),
                  gps: target.image.lngLat,
                  sphereCorrection: {
                    pan: (-(target.image.heading ?? 0) * Math.PI) / 180,
                  },
                  // Only offer hops to providers the user has already accepted.
                  // The plugin fetches the target panorama the instant an arrow
                  // is clicked, so filtering here is what keeps the consent gate
                  // meaningful — a dialog shown afterwards is too late.
                  links: target.arrows
                    .filter((arrow) => acceptedProvidersRef.current.includes(arrow.providerId))
                    .map((arrow) => ({
                      nodeId: formatStreetLevelRef({
                        providerId: arrow.providerId,
                        imageId: arrow.id,
                      }),
                      gps: arrow.lngLat,
                    })),
                };
              },
            },
          ],
        ],
      });

      viewerRef.current = viewer as unknown as { destroy: () => void };

      const tour = (viewer as unknown as { getPlugin: (plugin: unknown) => TourPlugin }).getPlugin(
        VirtualTourPlugin,
      );
      tourRef.current = tour;

      // `node-changed` is a PLUGIN event, not a Viewer event. Attaching it to
      // the viewer silently never fires, which would freeze the store, the
      // info card and the deep link on the first image.
      tour.addEventListener("node-changed", (event: unknown) => {
        const nodeId = (event as { node?: { id?: string } }).node?.id;
        const ref = nodeId ? parseStreetLevelRef(nodeId) : null;
        if (ref) requestImageLoadRef.current(ref);
      });

      const initial = activeRefStringRef.current;
      if (initial) navigateTo(tour, initial);
    })();

    return () => {
      unmounted = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      tourRef.current = null;
    };
  }, [apiUrl, isPano, navigateTo]);

  // Drive navigation imperatively when the store changes from outside the
  // viewer (pegman, deep link, search). Skipped when the plugin is already on
  // that node, which is what breaks the node-changed -> store -> viewer cycle.
  //
  // Only hand the plugin a target once we know it is panoramic: PSV would
  // otherwise download a flat photo and wrap it round the sphere until the
  // node load flips `isPano` and tears the viewer down.
  const loadedIsPanoFor = node?.id === activeRefString && node.image.isPano;
  useEffect(() => {
    const tour = tourRef.current;
    if (!tour || !activeRefString || !loadedIsPanoFor) return;
    if (lastNodeIdRef.current === activeRefString) return;
    navigateTo(tour, activeRefString);
  }, [activeRefString, loadedIsPanoFor, navigateTo]);

  // Attribute the photo to the provider that actually owns it. Deriving this
  // from `activeImage` instead would briefly credit the new provider while the
  // previous node is still on screen during a cross-provider hop.
  const provider = providers.find((p) => p.id === node?.image.providerId);

  // The minimap doubles as the way back: it shows where you are standing, and
  // clicking it returns to the map centred on that spot rather than wherever
  // the map happened to be when the viewer opened.
  const currentLngLat = node?.image.lngLat;
  const handleMinimapClick = useCallback(() => {
    if (currentLngLat) flyTo(currentLngLat, 18);
    closeViewer();
  }, [currentLngLat, flyTo, closeViewer]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 30, background: "#000" }}>
      {node && !node.image.isPano ? (
        <StreetLevelFlatImage
          image={node.image}
          arrows={node.arrows}
          onNavigate={(arrow) =>
            requestImageLoad({ providerId: arrow.providerId, imageId: arrow.id })
          }
        />
      ) : (
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      )}

      <SearchBar surface="street-level" />

      {failed && (
        <Typography
          sx={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            textAlign: "center",
            color: "rgba(255,255,255,0.8)",
            fontSize: 14,
          }}
        >
          {t("imageUnavailable")}
        </Typography>
      )}

      {node && provider && (
        <StreetLevelInfoCard image={node.image} provider={provider} onClose={closeViewer} />
      )}

      {node && (
        <LocationMinimap
          lng={node.image.lngLat[0]}
          lat={node.image.lngLat[1]}
          zoom={17}
          onClick={handleMinimapClick}
          sx={{
            position: "absolute",
            right: 12,
            // Lifted off the bottom edge so the whole minimap — including the
            // credits control in its corner — stays clear of the screen edge.
            bottom: 28,
            width: { xs: 132, sm: 196 },
            height: { xs: 96, sm: 132 },
            borderRadius: "10px",
            overflow: "hidden",
            border: "2px solid rgba(255,255,255,0.85)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
            cursor: "pointer",
            zIndex: 10,
          }}
        />
      )}

      <IconButton
        onClick={closeViewer}
        aria-label={tc("close")}
        sx={{
          position: "absolute",
          top: 8,
          right: 8,
          bgcolor: "rgba(0,0,0,0.5)",
          color: "#fff",
          borderRadius: "50%",
          p: 1.2,
          "&:hover": { bgcolor: "rgba(0,0,0,0.7)" },
        }}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}
