import { Suspense } from "react";
import { DirectionsDestinationMarker } from "@/components/map/DirectionsDestinationMarker";
import { LayerSelector } from "@/components/map/LayerSelector";
import { RouteLayer } from "@/components/map/layers/RouteLayer";
import { SatelliteLayer } from "@/components/map/layers/SatelliteLayer";
import { TerrainLayer } from "@/components/map/layers/TerrainLayer";
import { TrafficLayer } from "@/components/map/layers/TrafficLayer";
import { TransitLayer } from "@/components/map/layers/TransitLayer";
import { MapCanvas } from "@/components/map/MapCanvas";
import { MapControls } from "@/components/map/MapControls";
import { PlaceDeepLink } from "@/components/map/PlaceDeepLink";
import { SelectedPlaceMarker } from "@/components/map/SelectedPlaceMarker";
import { TopRightControls } from "@/components/map/TopRightControls";
import { UserLocationMarker } from "@/components/map/UserLocationMarker";
import { DirectionsPanel } from "@/components/panels/DirectionsPanel";
import { PlacePanel } from "@/components/panels/PlacePanel";
import { SearchBar } from "@/components/search/SearchBar";
import { MapProvider } from "@/lib/MapContext";

export default function HomePage() {
  return (
    <MapProvider>
      <div className="relative w-full h-dvh overflow-hidden">
        <MapCanvas />
        <SatelliteLayer />
        <TerrainLayer />
        <TrafficLayer />
        <TransitLayer />
        <RouteLayer />
        <UserLocationMarker />
        <SelectedPlaceMarker />
        <DirectionsDestinationMarker />
        <SearchBar />
        <PlacePanel />
        <DirectionsPanel />
        <TopRightControls />
        <LayerSelector />
        <MapControls />
        <Suspense>
          <PlaceDeepLink />
        </Suspense>
      </div>
    </MapProvider>
  );
}
