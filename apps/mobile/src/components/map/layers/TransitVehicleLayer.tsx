import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { TripLeg, VehicleJourneyStop } from "@openmapx/core";
import { MODE_COLORS, useDirectionsStore, useVehicleJourney } from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SOURCE_ID = "transit-vehicle-positions-source";

interface VehicleFeature {
  tripId: string;
  lat: number;
  lng: number;
  label: string;
  color: string;
  mode: string;
}

function estimatePosition(
  stops: VehicleJourneyStop[],
  leg: TripLeg,
): { lat: number; lng: number; delay: number | undefined } | null {
  if (stops.length === 0) return null;

  const now = Date.now();
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

  if (currentIdx < startIdx) {
    if (currentIdx >= 0) {
      return {
        lat: stops[currentIdx].lat,
        lng: stops[currentIdx].lng,
        delay: stops[currentIdx].delaySeconds,
      };
    }
    return {
      lat: stops[startIdx].lat,
      lng: stops[startIdx].lng,
      delay: stops[startIdx].delaySeconds,
    };
  }

  if (currentIdx > endIdx) {
    return {
      lat: stops[endIdx].lat,
      lng: stops[endIdx].lng,
      delay: stops[endIdx].delaySeconds,
    };
  }

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
  const lat = currentStop.lat + (nextStop.lat - currentStop.lat) * progress;
  const lng = currentStop.lng + (nextStop.lng - currentStop.lng) * progress;
  return { lat, lng, delay };
}

function legMarkerColor(leg: TripLeg): string {
  if (leg.route?.color) return `#${leg.route.color.replace("#", "")}`;
  return MODE_COLORS[leg.mode] ?? "#007b8b";
}

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
      pos.delay != null && pos.delay > 0 ? ` (+${Math.round(pos.delay / 60)}')` : "";

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
  const { mode, transitItineraries, activeItineraryIndex } = useDirectionsStore();
  const featuresRef = useRef(new Map<string, VehicleFeature>());
  const [geoJson, setGeoJson] = useState({
    type: "FeatureCollection" as const,
    features: [] as Array<{
      type: "Feature";
      properties: { label: string; color: string; mode: string };
      geometry: { type: "Point"; coordinates: [number, number] };
    }>,
  });

  const itinerary = mode === "transit" ? transitItineraries[activeItineraryIndex] : null;

  const transitLegs = useMemo(() => {
    if (!itinerary) return [];
    return itinerary.legs.filter((l) => l.mode !== "walking" && l.tripId);
  }, [itinerary]);

  const updateSource = useCallback((tripId: string, feature: VehicleFeature | null) => {
    if (feature) {
      featuresRef.current.set(tripId, feature);
    } else {
      featuresRef.current.delete(tripId);
    }

    setGeoJson({
      type: "FeatureCollection",
      features: [...featuresRef.current.values()].map((f) => ({
        type: "Feature" as const,
        properties: { label: f.label, color: f.color, mode: f.mode },
        geometry: {
          type: "Point" as const,
          coordinates: [f.lng, f.lat] as [number, number],
        },
      })),
    });
  }, []);

  // Clear when no transit legs
  useEffect(() => {
    if (transitLegs.length === 0) {
      featuresRef.current.clear();
      setGeoJson({ type: "FeatureCollection", features: [] });
    }
  }, [transitLegs]);

  if (transitLegs.length === 0) return null;

  return (
    <>
      {transitLegs.map((leg) => (
        <LegVehicle key={leg.tripId} leg={leg} onUpdate={updateSource} />
      ))}
      <GeoJSONSource id={SOURCE_ID} data={geoJson}>
        <Layer
          type="circle"
          id="transit-vehicle-positions-circle"
          source={SOURCE_ID}
          paint={{
            "circle-radius": 8,
            "circle-color": ["get", "color"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          }}
        />
        <Layer
          type="symbol"
          id="transit-vehicle-positions-label"
          source={SOURCE_ID}
          layout={{
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-offset": [0, 1.8],
            "text-anchor": "top",
            "text-allow-overlap": true,
          }}
          paint={{
            "text-color": "#333",
            "text-halo-color": "#fff",
            "text-halo-width": 1.5,
          }}
        />
      </GeoJSONSource>
    </>
  );
}
