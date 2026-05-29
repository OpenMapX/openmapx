"use client";

import { useDirectionsStore, useVehicleJourney } from "@openmapx/core";
import type { TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import type { GeoJSONSource } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import {
  loadTransitVehicleMarkers,
  modeColor,
  transitVehicleIconExpression,
} from "@/lib/transitMarkers";
import { removeLayerAndSource } from "./layerStyleUtils";

const SOURCE_ID = "transit-vehicle-positions-source";
const LAYER_ID = "transit-vehicle-positions-layer";
const LABEL_LAYER_ID = "transit-vehicle-positions-label";

interface VehicleFeature {
  tripId: string;
  lat: number;
  lng: number;
  label: string;
  color: string;
  mode: string;
}

/**
 * Estimate the vehicle's current position from the journey's stop progress.
 * Only shows the vehicle if it's currently within the user's leg segment
 * (between their boarding and alighting stops).
 */
function estimatePosition(
  stops: VehicleJourneyStop[],
  leg: TripLeg,
): { lat: number; lng: number; delay: number | undefined } | null {
  if (stops.length === 0) return null;

  const now = Date.now();

  // Find the leg's boarding/alighting stops within the full journey
  const fromBare = (leg.from.stopId ?? "").replace(/^[^:]+:/, "");
  const toBare = (leg.to.stopId ?? "").replace(/^[^:]+:/, "");

  let startIdx = 0;
  let endIdx = stops.length - 1;

  if (fromBare) {
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].stopId.replace(/^[^:]+:/, "") === fromBare) {
        startIdx = i;
        break;
      }
    }
  }
  if (toBare) {
    for (let i = stops.length - 1; i >= startIdx; i--) {
      if (stops[i].stopId.replace(/^[^:]+:/, "") === toBare) {
        endIdx = i;
        break;
      }
    }
  }

  // Find the vehicle's current stop index using departed flags or time
  let currentIdx = -1;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].departed) {
      currentIdx = i;
    } else {
      const dep = stops[i].expectedDeparture ?? stops[i].scheduledDeparture;
      if (dep && new Date(dep).getTime() <= now) {
        currentIdx = i;
      } else {
        break;
      }
    }
  }

  // Vehicle hasn't reached the user's boarding stop yet — show at its current position
  // (or at the boarding stop if it hasn't departed at all)
  if (currentIdx < startIdx) {
    if (currentIdx >= 0) {
      // Vehicle is en route but hasn't reached boarding stop — show at current position
      return {
        lat: stops[currentIdx].lat,
        lng: stops[currentIdx].lng,
        delay: stops[currentIdx].delaySeconds,
      };
    }
    // Vehicle hasn't departed at all — show at the boarding stop
    return {
      lat: stops[startIdx].lat,
      lng: stops[startIdx].lng,
      delay: stops[startIdx].delaySeconds,
    };
  }

  // Vehicle already past the user's alighting stop — show at alighting stop
  if (currentIdx > endIdx) {
    return { lat: stops[endIdx].lat, lng: stops[endIdx].lng, delay: stops[endIdx].delaySeconds };
  }

  // Vehicle is within the user's segment — interpolate
  const currentStop = stops[currentIdx];
  const delay = currentStop.delaySeconds;
  const nextIdx = currentIdx + 1;

  if (nextIdx > endIdx || nextIdx >= stops.length) {
    return { lat: currentStop.lat, lng: currentStop.lng, delay };
  }

  const nextStop = stops[nextIdx];
  const depTime = currentStop.expectedDeparture ?? currentStop.scheduledDeparture;
  const arrTime = nextStop.expectedArrival ?? nextStop.scheduledArrival;

  if (!depTime || !arrTime) {
    return { lat: currentStop.lat, lng: currentStop.lng, delay };
  }

  const depMs = new Date(depTime).getTime();
  const arrMs = new Date(arrTime).getTime();
  const span = arrMs - depMs;
  if (span <= 0) return { lat: currentStop.lat, lng: currentStop.lng, delay };

  const progress = Math.max(0, Math.min(1, (now - depMs) / span));

  // Interpolate along leg geometry if possible
  const geom = leg.geometry.coordinates;
  if (geom.length >= 2) {
    const legStopCount = endIdx - startIdx;
    if (legStopCount > 0) {
      const segStart = (currentIdx - startIdx) / legStopCount;
      const segEnd = (nextIdx - startIdx) / legStopCount;
      const frac = segStart + (segEnd - segStart) * progress;
      const pos = interpolateAlongLine(geom, frac);
      if (pos) return { lat: pos[1], lng: pos[0], delay };
    }
  }

  // Linear interpolation between stop coordinates
  const lat = currentStop.lat + (nextStop.lat - currentStop.lat) * progress;
  const lng = currentStop.lng + (nextStop.lng - currentStop.lng) * progress;
  return { lat, lng, delay };
}

function interpolateAlongLine(
  coords: [number, number][],
  fraction: number,
): [number, number] | null {
  if (coords.length < 2) return null;
  if (fraction <= 0) return coords[0];
  if (fraction >= 1) return coords[coords.length - 1];

  let totalLen = 0;
  const segLengths: number[] = [];
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    segLengths.push(Math.sqrt(dx * dx + dy * dy));
    totalLen += segLengths[segLengths.length - 1];
  }
  if (totalLen === 0) return coords[0];

  const target = fraction * totalLen;
  let acc = 0;
  for (let i = 0; i < segLengths.length; i++) {
    if (acc + segLengths[i] >= target) {
      const f = (target - acc) / segLengths[i];
      return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f,
      ];
    }
    acc += segLengths[i];
  }
  return coords[coords.length - 1];
}

function legMarkerColor(leg: TripLeg): string {
  if (leg.route?.color) return `#${leg.route.color.replace("#", "")}`;
  return modeColor(leg.mode);
}

/** Sub-component: one per transit leg. Calls useVehicleJourney individually. */
function LegVehicle({
  leg,
  onUpdate,
}: {
  leg: TripLeg;
  onUpdate: (tripId: string, feature: VehicleFeature | null) => void;
}) {
  const { data: journey } = useVehicleJourney(leg.tripId ?? null);

  useEffect(() => {
    const tripId = leg.tripId;
    if (!tripId || !journey?.stops?.length) {
      if (tripId) onUpdate(tripId, null);
      return;
    }

    const pos = estimatePosition(journey.stops, leg);
    if (!pos) {
      onUpdate(tripId, null);
      return;
    }

    const routeName = leg.route?.shortName ?? "";
    const delayText =
      pos.delay != null && pos.delay > 0 ? ` (+${Math.round(pos.delay / 60)}′)` : "";

    onUpdate(tripId, {
      tripId,
      lat: pos.lat,
      lng: pos.lng,
      label: `${routeName}${delayText}`,
      color: legMarkerColor(leg),
      mode: leg.mode,
    });
  }, [journey, leg, onUpdate]);

  return null;
}

export function TransitVehicleLayer() {
  const { mapRef } = useMap();
  const { mode, transitItineraries, activeItineraryIndex } = useDirectionsStore();
  const featuresRef = useRef(new Map<string, VehicleFeature>());

  const itinerary = mode === "transit" ? transitItineraries[activeItineraryIndex] : null;

  const transitLegs = useMemo(() => {
    if (!itinerary) return [];
    return itinerary.legs.filter((l) => l.mode !== "walking" && l.tripId);
  }, [itinerary]);

  // Update the GeoJSON source whenever a child reports a position change.
  // Creates source + layers on-demand if they don't exist yet (avoids race with lifecycle effect).
  const updateSource = useCallback(
    (tripId: string, feature: VehicleFeature | null) => {
      if (feature) {
        featuresRef.current.set(tripId, feature);
      } else {
        featuresRef.current.delete(tripId);
      }

      const map = mapRef.current;
      if (!map?.isStyleLoaded()) return;

      // Load icon images + ensure source + layers exist
      loadTransitVehicleMarkers(map);

      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer(LAYER_ID)) {
        map.addLayer({
          id: LAYER_ID,
          type: "symbol",
          source: SOURCE_ID,
          layout: {
            "icon-image": transitVehicleIconExpression() as maplibregl.ExpressionSpecification,
            "icon-size": 0.9,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
      }
      if (!map.getLayer(LABEL_LAYER_ID)) {
        map.addLayer({
          id: LABEL_LAYER_ID,
          type: "symbol",
          source: SOURCE_ID,
          layout: {
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-offset": [0, 1.8],
            "text-anchor": "top",
            "text-allow-overlap": true,
          },
          paint: {
            "text-color": "#333",
            "text-halo-color": "#fff",
            "text-halo-width": 1.5,
          },
        });
      }

      const source = map.getSource(SOURCE_ID) as GeoJSONSource;
      source.setData({
        type: "FeatureCollection",
        features: [...featuresRef.current.values()].map((f) => ({
          type: "Feature" as const,
          properties: { label: f.label, color: f.color, mode: f.mode },
          geometry: { type: "Point" as const, coordinates: [f.lng, f.lat] },
        })),
      });
    },
    [mapRef],
  );

  // Cleanup when no transit legs or component unmounts
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (transitLegs.length === 0) {
      removeLayerAndSource(map, [LABEL_LAYER_ID, LAYER_ID], SOURCE_ID);
      featuresRef.current.clear();
    }

    return () => {
      removeLayerAndSource(map, [LABEL_LAYER_ID, LAYER_ID], SOURCE_ID);
      featuresRef.current.clear();
    };
  }, [mapRef, transitLegs]);

  return (
    <>
      {transitLegs.map((leg) => (
        <LegVehicle key={leg.tripId} leg={leg} onUpdate={updateSource} />
      ))}
    </>
  );
}
