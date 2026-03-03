import { Suspense } from "react";
import { DirectionsDestinationMarker } from "@/components/map/DirectionsDestinationMarker";
import { RouteLayer } from "@/components/map/layers/RouteLayer";
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
        <RouteLayer />
        <UserLocationMarker />
        <SelectedPlaceMarker />
        <DirectionsDestinationMarker />
        <SearchBar />
        <PlacePanel />
        <DirectionsPanel />
        <TopRightControls />
        <MapControls />
        <Suspense>
          <PlaceDeepLink />
        </Suspense>
      </div>
    </MapProvider>
  );
}
