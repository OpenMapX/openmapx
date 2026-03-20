import { Suspense } from "react";
import { AirQualityLegend } from "@/components/map/AirQualityLegend";
import { CategoryResultMarkers } from "@/components/map/CategoryResultMarkers";
import { CyclingLegend } from "@/components/map/CyclingLegend";
import { DataSourceDetailBridge } from "@/components/map/DataSourceDetailBridge";
import { DirectionsDestinationMarker } from "@/components/map/DirectionsDestinationMarker";
import { EarthquakeLegend } from "@/components/map/EarthquakeLegend";
import { HikingTrailsLegend } from "@/components/map/HikingTrailsLegend";
import { LayerSelector } from "@/components/map/layer-selector/LayerSelector";
import { AirQualityLayer } from "@/components/map/layers/AirQualityLayer";
import { CyclingLayer } from "@/components/map/layers/CyclingLayer";
import { DataSourceLayer } from "@/components/map/layers/DataSourceLayer";
import { EarthquakeLayer } from "@/components/map/layers/EarthquakeLayer";
import { HikingTrailsLayer } from "@/components/map/layers/HikingTrailsLayer";
import { MountainShelterLayer } from "@/components/map/layers/MountainShelterLayer";
import { RasterBaseLayer } from "@/components/map/layers/RasterBaseLayer";
import { RouteLayer } from "@/components/map/layers/RouteLayer";
import { SavedPlacesLayer } from "@/components/map/layers/SavedPlacesLayer";
import { StreetViewLayer } from "@/components/map/layers/StreetViewLayer";
import { TrafficLayer } from "@/components/map/layers/TrafficLayer";
import { TransitItineraryLayer } from "@/components/map/layers/TransitItineraryLayer";
import { TransitLayer } from "@/components/map/layers/TransitLayer";
import { TransitRouteLayer } from "@/components/map/layers/TransitRouteLayer";
import { VehicleLiveLayer } from "@/components/map/layers/VehicleLiveLayer";
import { WinterSportsLayer } from "@/components/map/layers/WinterSportsLayer";
import { MapCanvas } from "@/components/map/MapCanvas";
import { MapClickHandler } from "@/components/map/MapClickHandler";
import { MapControls } from "@/components/map/MapControls";
import { MapFooter } from "@/components/map/MapFooter";
import { MapStylePoiClickHandler } from "@/components/map/MapStylePoiClickHandler";
import { PlaceDeepLink } from "@/components/map/PlaceDeepLink";
import { SearchInAreaChip } from "@/components/map/SearchInAreaChip";
import { SelectedPlaceMarker } from "@/components/map/SelectedPlaceMarker";
import { StreetViewLegend } from "@/components/map/StreetViewLegend";
import { StreetViewViewer } from "@/components/map/StreetViewViewer";
import { TopRightControls } from "@/components/map/TopRightControls";
import { UserLocationMarker } from "@/components/map/UserLocationMarker";
import { WinterSportsLegend } from "@/components/map/WinterSportsLegend";
import { HamburgerMenu } from "@/components/menu/HamburgerMenu";
import { MapClickFloatingCard } from "@/components/panels/MapClickFloatingCard";
import { PanelHost } from "@/components/panels/PanelHost";
import { CategoryChips } from "@/components/search/CategoryChips";
import { CategoryFilterBar } from "@/components/search/CategoryFilterBar";
import { SearchBar } from "@/components/search/SearchBar";
import { MapProvider } from "@/lib/MapContext";

export default function HomePage() {
  return (
    <MapProvider>
      <div className="relative w-full h-dvh overflow-hidden">
        <MapCanvas />
        <RasterBaseLayer
          sourceId="openmapx-satellite-source"
          layerId="openmapx-satellite-layer"
          tiles={
            process.env.NEXT_PUBLIC_MAPTILER_KEY
              ? [
                  `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`,
                ]
              : []
          }
          activeWhen="satellite"
          maxzoom={20}
          attribution='© <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> (<a href="https://www.maptiler.com/copyright/" target="_blank">Proprietary</a>)'
        />
        <RasterBaseLayer
          sourceId="openmapx-terrain-source"
          layerId="openmapx-terrain-layer"
          tiles={["https://tile.opentopomap.org/{z}/{x}/{y}.png"]}
          activeWhen="terrain"
          maxzoom={17}
          attribution='© <a href="https://opentopomap.org/about" target="_blank">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank">CC-BY-SA</a>)'
          paint={{ "raster-opacity": 0.95, "raster-saturation": -0.15 }}
        />
        <RasterBaseLayer
          sourceId="openmapx-cyclosm-source"
          layerId="openmapx-cyclosm-layer"
          tiles={[
            process.env.NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE ??
              (process.env.NEXT_PUBLIC_API_URL
                ? `${process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "")}/api/tiles/cyclosm/{z}/{x}/{y}.png`
                : "/api/tiles/cyclosm/{z}/{x}/{y}.png"),
          ]}
          activeWhen="cycling"
          maxzoom={20}
          attribution='© <a href="https://www.cyclosm.org/" target="_blank">CyclOSM</a> hosted by <a href="https://openstreetmap.fr/" target="_blank">OpenStreetMap France</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors (<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank">CC-BY-SA</a>)'
          paint={{ "raster-opacity": 0.95 }}
        />
        <TrafficLayer />
        <TransitLayer />
        <CyclingLayer />
        <RouteLayer />
        <TransitRouteLayer />
        <VehicleLiveLayer />
        <TransitItineraryLayer />
        <StreetViewLayer />
        <AirQualityLayer />
        <EarthquakeLayer />
        <WinterSportsLayer />
        <HikingTrailsLayer />
        <MountainShelterLayer />
        <CategoryResultMarkers />
        <DataSourceLayer />
        <SavedPlacesLayer />
        <DataSourceDetailBridge />
        <MapClickHandler />
        <MapStylePoiClickHandler />
        <UserLocationMarker />
        <SelectedPlaceMarker />
        <DirectionsDestinationMarker />
        <HamburgerMenu />
        <SearchBar />
        <CategoryChips />
        <CategoryFilterBar />
        <SearchInAreaChip />
        <PanelHost />
        <MapClickFloatingCard />
        <TopRightControls />
        <StreetViewViewer />
        <StreetViewLegend />
        <AirQualityLegend />
        <EarthquakeLegend />
        <CyclingLegend />
        <WinterSportsLegend />
        <HikingTrailsLegend />
        <LayerSelector />
        <MapControls />
        <MapFooter />
        <Suspense>
          <PlaceDeepLink />
        </Suspense>
      </div>
    </MapProvider>
  );
}
