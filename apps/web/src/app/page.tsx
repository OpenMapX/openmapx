import { Suspense } from "react";
import { AirQualityLegend } from "@/components/map/AirQualityLegend";
import { CategoryResultMarkers } from "@/components/map/CategoryResultMarkers";
import { DirectionsDestinationMarker } from "@/components/map/DirectionsDestinationMarker";
import { LayerSelector } from "@/components/map/LayerSelector";
import { AirQualityLayer } from "@/components/map/layers/AirQualityLayer";
import { RouteLayer } from "@/components/map/layers/RouteLayer";
import { SatelliteLayer } from "@/components/map/layers/SatelliteLayer";
import { StreetViewLayer } from "@/components/map/layers/StreetViewLayer";
import { TerrainLayer } from "@/components/map/layers/TerrainLayer";
import { TrafficLayer } from "@/components/map/layers/TrafficLayer";
import { TransitItineraryLayer } from "@/components/map/layers/TransitItineraryLayer";
import { TransitLayer } from "@/components/map/layers/TransitLayer";
import { TransitRouteLayer } from "@/components/map/layers/TransitRouteLayer";
import { VehicleLiveLayer } from "@/components/map/layers/VehicleLiveLayer";
import { MapCanvas } from "@/components/map/MapCanvas";
import { MapClickHandler } from "@/components/map/MapClickHandler";
import { MapControls } from "@/components/map/MapControls";
import { MapStylePoiClickHandler } from "@/components/map/MapStylePoiClickHandler";
import { PlaceDeepLink } from "@/components/map/PlaceDeepLink";
import { SearchInAreaChip } from "@/components/map/SearchInAreaChip";
import { SelectedPlaceMarker } from "@/components/map/SelectedPlaceMarker";
import { StreetViewLegend } from "@/components/map/StreetViewLegend";
import { StreetViewViewer } from "@/components/map/StreetViewViewer";
import { TopRightControls } from "@/components/map/TopRightControls";
import { UserLocationMarker } from "@/components/map/UserLocationMarker";
import { CategoryPlaceFloatingCard } from "@/components/panels/CategoryPlaceFloatingCard";
import { CategoryResultsPanel } from "@/components/panels/CategoryResultsPanel";
import { DirectionsPanel } from "@/components/panels/DirectionsPanel";
import { MapClickFloatingCard } from "@/components/panels/MapClickFloatingCard";
import { PlacePanel } from "@/components/panels/PlacePanel";
import { CategoryChips } from "@/components/search/CategoryChips";
import { CategoryFilterBar } from "@/components/search/CategoryFilterBar";
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
        <TransitRouteLayer />
        <VehicleLiveLayer />
        <TransitItineraryLayer />
        <StreetViewLayer />
        <AirQualityLayer />
        <CategoryResultMarkers />
        <MapClickHandler />
        <MapStylePoiClickHandler />
        <UserLocationMarker />
        <SelectedPlaceMarker />
        <DirectionsDestinationMarker />
        <SearchBar />
        <CategoryChips />
        <CategoryFilterBar />
        <SearchInAreaChip />
        <PlacePanel />
        <CategoryResultsPanel />
        <CategoryPlaceFloatingCard />
        <MapClickFloatingCard />
        <DirectionsPanel />
        <TopRightControls />
        <StreetViewViewer />
        <StreetViewLegend />
        <AirQualityLegend />
        <LayerSelector />
        <MapControls />
        <Suspense>
          <PlaceDeepLink />
        </Suspense>
      </div>
    </MapProvider>
  );
}
