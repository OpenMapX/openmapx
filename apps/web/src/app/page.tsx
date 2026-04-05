import { Suspense } from "react";
import { ElevationHoverProvider } from "@/components/elevation/ElevationHoverContext";
import { CategoryResultMarkers } from "@/components/map/CategoryResultMarkers";
import { DataSourceDetailBridge } from "@/components/map/DataSourceDetailBridge";
import { ElevationHoverMarker } from "@/components/map/ElevationHoverMarker";
import { LegendHost } from "@/components/map/LegendHost";
import { LayerSelector } from "@/components/map/layer-selector/LayerSelector";
import { CyclingBaseLayer } from "@/components/map/layers/CyclingBaseLayer";
import { DataSourceLayer } from "@/components/map/layers/DataSourceLayer";
import { GlobeProjection } from "@/components/map/layers/GlobeProjection";
import { RasterBaseLayer } from "@/components/map/layers/RasterBaseLayer";
import { RouteLayer } from "@/components/map/layers/RouteLayer";
import { SavedPlacesLayer } from "@/components/map/layers/SavedPlacesLayer";
import { TransitItineraryLayer } from "@/components/map/layers/TransitItineraryLayer";
import { TransitRouteLayer } from "@/components/map/layers/TransitRouteLayer";
import { TransitVehicleLayer } from "@/components/map/layers/TransitVehicleLayer";
import { VehicleLiveLayer } from "@/components/map/layers/VehicleLiveLayer";
import { MapCanvas } from "@/components/map/MapCanvas";
import { MapClickHandler } from "@/components/map/MapClickHandler";
import { MapControls } from "@/components/map/MapControls";
import { MapFooter } from "@/components/map/MapFooter";
import { MapLayerHost } from "@/components/map/MapLayerHost";
import { MapStylePoiClickHandler } from "@/components/map/MapStylePoiClickHandler";
import { PlaceDeepLink } from "@/components/map/PlaceDeepLink";
import { SearchInAreaChip } from "@/components/map/SearchInAreaChip";
import { SelectedPlaceMarker } from "@/components/map/SelectedPlaceMarker";
import { StreetViewViewer } from "@/components/map/StreetViewViewer";
import { TopRightControls } from "@/components/map/TopRightControls";
import { UserLocationMarker } from "@/components/map/UserLocationMarker";
import { WaypointMarkers } from "@/components/map/WaypointMarkers";
import { HamburgerMenu } from "@/components/menu/HamburgerMenu";
import { MapClickFloatingCard } from "@/components/panels/MapClickFloatingCard";
import { PanelHost } from "@/components/panels/PanelHost";
import { CategoryChips } from "@/components/search/CategoryChips";
import { CategoryFilterBar } from "@/components/search/CategoryFilterBar";
import { SearchBar } from "@/components/search/SearchBar";
import { WeatherWidget } from "@/components/weather/WeatherWidget";
import { MapProvider } from "@/lib/MapContext";

export default function HomePage() {
  return (
    <MapProvider>
      <ElevationHoverProvider>
        <div className="relative w-full h-dvh overflow-hidden">
          <MapCanvas />
          <GlobeProjection />
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
          <CyclingBaseLayer />
          {/* Core layers (not integration-managed) */}
          <RouteLayer />
          <TransitRouteLayer />
          <VehicleLiveLayer />
          <TransitItineraryLayer />
          <TransitVehicleLayer />
          <CategoryResultMarkers />
          <DataSourceLayer />
          <SavedPlacesLayer />
          {/* All overlay/tool layers loaded dynamically by MapLayerHost */}
          <MapLayerHost />
          <DataSourceDetailBridge />
          <MapClickHandler />
          <MapStylePoiClickHandler />
          <UserLocationMarker />
          <SelectedPlaceMarker />
          <WaypointMarkers />
          <ElevationHoverMarker />
          <HamburgerMenu />
          <SearchBar />
          <WeatherWidget />
          <CategoryChips />
          <CategoryFilterBar />
          <SearchInAreaChip />
          <PanelHost />
          <MapClickFloatingCard />
          <TopRightControls />
          <StreetViewViewer />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex flex-col-reverse items-center gap-2 pointer-events-none [&>*]:pointer-events-auto">
            {/* All legends/toolbars loaded dynamically by LegendHost */}
            <LegendHost />
          </div>
          <LayerSelector />
          <MapControls />
          <MapFooter />
          <Suspense>
            <PlaceDeepLink />
          </Suspense>
        </div>
      </ElevationHoverProvider>
    </MapProvider>
  );
}
