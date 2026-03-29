import type { PressEvent } from "@maplibre/maplibre-react-native";
import { Camera, Map as MapView, NativeUserLocation } from "@maplibre/maplibre-react-native";
import type { LngLat } from "@openmapx/core";
import {
  useDirectionsStore,
  useMapClickStore,
  useMapStore,
  useMeasurementStore,
  useTravelTimeStore,
} from "@openmapx/core";
import { useCallback, useEffect, useRef } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { StyleSheet, useColorScheme } from "react-native";
import { useMap } from "@/lib/MapContext";
import { AirQualityLayer } from "./layers/AirQualityLayer";
import { BuildingExtrusionLayer } from "./layers/BuildingExtrusionLayer";
import { CategoryResultMarkers } from "./layers/CategoryResultMarkers";
import { CyclingLayer } from "./layers/CyclingLayer";
import { DataSourceLayer } from "./layers/DataSourceLayer";
import { EarthquakeLayer } from "./layers/EarthquakeLayer";
import { GlobeProjection } from "./layers/GlobeProjection";
import { HikingTrailsLayer } from "./layers/HikingTrailsLayer";
import { LiveTrainsLayer } from "./layers/LiveTrainsLayer";
import { MeasurementLayer } from "./layers/MeasurementLayer";
import { MountainShelterLayer } from "./layers/MountainShelterLayer";
import { RasterBaseLayer } from "./layers/RasterBaseLayer";
import { RouteLayer } from "./layers/RouteLayer";
import { SavedPlacesLayer } from "./layers/SavedPlacesLayer";
import { StreetViewLayer } from "./layers/StreetViewLayer";
import { TrafficLayer } from "./layers/TrafficLayer";
import { TransitItineraryLayer } from "./layers/TransitItineraryLayer";
import { TransitLayer } from "./layers/TransitLayer";
import { TransitRouteLayer } from "./layers/TransitRouteLayer";
import { TransitVehicleLayer } from "./layers/TransitVehicleLayer";
import { TravelTimeLayer } from "./layers/TravelTimeLayer";
import { VehicleLiveLayer } from "./layers/VehicleLiveLayer";
import { WildfireLayer } from "./layers/WildfireLayer";
import { WinterSportsLayer } from "./layers/WinterSportsLayer";
import { DirectionsDestinationMarker } from "./markers/DirectionsDestinationMarker";
import { ElevationHoverMarker } from "./markers/ElevationHoverMarker";
import { SelectedPlaceMarker } from "./markers/SelectedPlaceMarker";
import { WaypointMarkers } from "./markers/WaypointMarkers";

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";

function getStyleUrl(colorScheme: string | null | undefined): string {
  const style = colorScheme === "dark" ? "streets-v2-dark" : "bright-v2";
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
}

export function MapCanvas() {
  const { mapRef, cameraRef, notifyMapReady, notifyStyleReload } = useMap();
  const colorScheme = useColorScheme();
  const setViewport = useMapStore((s) => s.setViewport);
  const styleUrl = getStyleUrl(colorScheme);
  const prevStyleUrl = useRef(styleUrl);

  useEffect(() => {
    if (prevStyleUrl.current !== styleUrl) {
      prevStyleUrl.current = styleUrl;
      notifyStyleReload();
    }
  }, [styleUrl, notifyStyleReload]);

  const handlePress = useCallback((event: NativeSyntheticEvent<PressEvent>) => {
    const { lngLat } = event.nativeEvent;
    const coord: LngLat = [lngLat[0], lngLat[1]];

    const measureState = useMeasurementStore.getState();
    if (measureState.isActive && !measureState.isFinalized) {
      measureState.addPoint(coord);
      return;
    }

    const travelState = useTravelTimeStore.getState();
    if (travelState.isActive) {
      travelState.setOrigin(coord);
      return;
    }

    // If directions panel is open, fill the next empty waypoint
    const dirState = useDirectionsStore.getState();
    if (dirState.isOpen) {
      const emptyIdx = dirState.waypoints.findIndex((wp) => !wp.coords);
      if (emptyIdx >= 0) {
        dirState.setWaypoint(emptyIdx, coord, `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`);
        return;
      }
    }

    // General map tap — trigger reverse geocoding via MapClickHandler
    useMapClickStore.getState().setClickedLngLat(coord);
  }, []);

  return (
    <MapView
      ref={mapRef}
      mapStyle={styleUrl}
      style={styles.map}
      attribution={false}
      logo={false}
      onDidFinishLoadingMap={notifyMapReady}
      onPress={handlePress}
      onRegionDidChange={(event) => {
        const { center, zoom, bearing, pitch } = event.nativeEvent;
        setViewport({
          center: center as [number, number],
          zoom,
          bearing,
          pitch,
        });
      }}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{ center: [0, 20], zoom: 2, bearing: 0, pitch: 0 }}
      />
      <NativeUserLocation />
      <RasterBaseLayer
        sourceId="openmapx-satellite-source"
        layerId="openmapx-satellite-layer"
        tiles={
          MAPTILER_KEY
            ? [`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`]
            : []
        }
        activeWhen="satellite"
        maxzoom={20}
      />
      <RasterBaseLayer
        sourceId="openmapx-terrain-source"
        layerId="openmapx-terrain-layer"
        tiles={["https://tile.opentopomap.org/{z}/{x}/{y}.png"]}
        activeWhen="terrain"
        maxzoom={17}
        paint={{ "raster-opacity": 0.95, "raster-saturation": -0.15 }}
      />
      <RasterBaseLayer
        sourceId="openmapx-cyclosm-source"
        layerId="openmapx-cyclosm-layer"
        tiles={[
          process.env.EXPO_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE ??
            `${process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001"}/api/tiles/cyclosm/{z}/{x}/{y}.png`,
        ]}
        activeWhen="cycling"
        maxzoom={20}
      />
      <TrafficLayer />
      <TransitLayer />
      <StreetViewLayer />
      <AirQualityLayer />
      <EarthquakeLayer />
      <WildfireLayer />
      <LiveTrainsLayer />
      <WinterSportsLayer />
      <HikingTrailsLayer />
      <MountainShelterLayer />
      <CyclingLayer />
      <SavedPlacesLayer />
      <CategoryResultMarkers />
      <DataSourceLayer />
      <VehicleLiveLayer />
      <BuildingExtrusionLayer />
      <GlobeProjection />
      <MeasurementLayer />
      <TravelTimeLayer />
      <RouteLayer />
      <TransitItineraryLayer />
      <TransitRouteLayer />
      <TransitVehicleLayer />
      <SelectedPlaceMarker />
      <WaypointMarkers />
      <DirectionsDestinationMarker />
      <ElevationHoverMarker />
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { ...StyleSheet.absoluteFillObject },
});
