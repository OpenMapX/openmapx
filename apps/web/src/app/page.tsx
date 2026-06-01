import type { Attribution } from "@openmapx/mobility-core/attribution";
import { Suspense } from "react";
import { GlobalKeybindings } from "@/components/command-palette/GlobalKeybindings";
import { ElevationHoverProvider } from "@/components/elevation/ElevationHoverContext";
import { BaseAttributions } from "@/components/map/BaseAttributions";
import { CategoryResultMarkers } from "@/components/map/CategoryResultMarkers";
import { DataSourceDetailBridge } from "@/components/map/DataSourceDetailBridge";
import { DeepLinkManager } from "@/components/map/DeepLinkManager";
import { ElevationHoverMarker } from "@/components/map/ElevationHoverMarker";
import { ExploreAnchorMarker } from "@/components/map/ExploreAnchorMarker";
import { ImportedGeometryBanner } from "@/components/map/ImportedGeometryBanner";
import { LegendHost } from "@/components/map/LegendHost";
import { LayerSelector } from "@/components/map/layer-selector/LayerSelector";
import { CyclingBaseLayer } from "@/components/map/layers/CyclingBaseLayer";
import { DataSourceLayer } from "@/components/map/layers/DataSourceLayer";
import { FlightArcLayer } from "@/components/map/layers/FlightArcLayer";
import { GlobeProjection } from "@/components/map/layers/GlobeProjection";
import { ImportedGeometryLayer } from "@/components/map/layers/ImportedGeometryLayer";
import { PlaceBoundaryLayer } from "@/components/map/layers/PlaceBoundaryLayer";
import { RasterBaseLayer } from "@/components/map/layers/RasterBaseLayer";
import { RouteLayer } from "@/components/map/layers/RouteLayer";
import { SavedPlacesLayer } from "@/components/map/layers/SavedPlacesLayer";
import { SelectedStopInfrastructureLayer } from "@/components/map/layers/SelectedStopInfrastructureLayer";
import { TransitItineraryLayer } from "@/components/map/layers/TransitItineraryLayer";
import { TransitRouteLayer } from "@/components/map/layers/TransitRouteLayer";
import { TransitVehicleLayer } from "@/components/map/layers/TransitVehicleLayer";
import { VehicleLiveLayer } from "@/components/map/layers/VehicleLiveLayer";
import { MapAttributionPositioner } from "@/components/map/MapAttributionPositioner";
import { MapCanvas } from "@/components/map/MapCanvas";
import { MapClickHandler } from "@/components/map/MapClickHandler";
import { MapControls } from "@/components/map/MapControls";
import { MapFooter } from "@/components/map/MapFooter";
import { MapLayerHost } from "@/components/map/MapLayerHost";
import { MapStylePoiClickHandler } from "@/components/map/MapStylePoiClickHandler";
import { SearchInAreaChip } from "@/components/map/SearchInAreaChip";
import { SelectedPlaceMarker } from "@/components/map/SelectedPlaceMarker";
import { StreetViewViewer } from "@/components/map/StreetViewViewer";
import { TopRightControls } from "@/components/map/TopRightControls";
import { UserLocationMarker } from "@/components/map/UserLocationMarker";
import { WaypointMarkers } from "@/components/map/WaypointMarkers";
import { HamburgerMenu } from "@/components/menu/HamburgerMenu";
import { MapClickFloatingCard } from "@/components/panels/MapClickFloatingCard";
import { PanelHost } from "@/components/panels/PanelHost";
import { ShareIntentHandler } from "@/components/pwa/ShareIntentHandler";
import { CategoryChips } from "@/components/search/CategoryChips";
import { CategoryFilterBar } from "@/components/search/CategoryFilterBar";
import { SearchBar } from "@/components/search/SearchBar";
import { WeatherWidget } from "@/components/weather/WeatherWidget";
import { MapProvider } from "@/lib/MapContext";

// Raster base layers register each Attribution as its own atomic side-channel
// source via `useMapAttributions`, so identical credits (notably "© OSM"
// shared with the always-loaded vector basemap) collapse automatically
// through MapLibre's substring dedup.
const SATELLITE_ATTRIBUTIONS: Attribution[] = [
  {
    sourceId: "maptiler",
    name: "© MapTiler",
    url: "https://www.maptiler.com/copyright/",
    licenseUrl: "https://www.maptiler.com/copyright/",
  },
  {
    sourceId: "openstreetmap",
    name: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    spdxLicense: "ODbL-1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
  },
];

const TERRAIN_ATTRIBUTIONS: Attribution[] = [
  {
    sourceId: "opentopomap",
    name: "© OpenTopoMap",
    url: "https://opentopomap.org/about",
    spdxLicense: "CC-BY-SA-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  },
  {
    sourceId: "openstreetmap",
    name: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    spdxLicense: "ODbL-1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
  },
];

function apiRoute(path: string): string {
  const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
  return apiBase ? `${apiBase}${path}` : path;
}

function getTerrainTileUrl(): string {
  if (process.env.NEXT_PUBLIC_TERRAIN_TILE_URL_TEMPLATE) {
    return process.env.NEXT_PUBLIC_TERRAIN_TILE_URL_TEMPLATE;
  }
  return apiRoute("/api/tiles/terrain/{z}/{x}/{y}.png");
}

export default function HomePage() {
  const terrainTileUrl = getTerrainTileUrl();
  const satelliteTiles = [apiRoute("/api/maptiler/tiles/satellite-v2/{z}/{x}/{y}.jpg")];
  return (
    <MapProvider>
      <GlobalKeybindings />
      <ElevationHoverProvider>
        <div className="relative w-full h-dvh overflow-hidden">
          <MapCanvas />
          <GlobeProjection />
          <BaseAttributions />
          <MapAttributionPositioner />
          <RasterBaseLayer
            sourceId="openmapx-satellite-source"
            layerId="openmapx-satellite-layer"
            tiles={satelliteTiles}
            activeWhen="satellite"
            maxzoom={20}
            attributions={SATELLITE_ATTRIBUTIONS}
          />
          <RasterBaseLayer
            sourceId="openmapx-terrain-source"
            layerId="openmapx-terrain-layer"
            tiles={[terrainTileUrl]}
            activeWhen="terrain"
            maxzoom={17}
            attributions={TERRAIN_ATTRIBUTIONS}
            paint={{ "raster-opacity": 0.95, "raster-saturation": -0.15 }}
          />
          <CyclingBaseLayer />
          {/* Core layers (not integration-managed) */}
          <PlaceBoundaryLayer />
          <RouteLayer />
          <FlightArcLayer />
          <TransitRouteLayer />
          <VehicleLiveLayer />
          <TransitItineraryLayer />
          <TransitVehicleLayer />
          <CategoryResultMarkers />
          <DataSourceLayer />
          <SavedPlacesLayer />
          <ImportedGeometryLayer />
          {/* All overlay/tool layers loaded dynamically by MapLayerHost */}
          <MapLayerHost />
          <DataSourceDetailBridge />
          <MapClickHandler />
          <MapStylePoiClickHandler />
          <UserLocationMarker />
          <SelectedPlaceMarker />
          <ExploreAnchorMarker />
          <SelectedStopInfrastructureLayer />
          <WaypointMarkers />
          <ElevationHoverMarker />
          <HamburgerMenu />
          <SearchBar />
          <WeatherWidget />
          <CategoryChips />
          <CategoryFilterBar />
          <SearchInAreaChip />
          <ImportedGeometryBanner />
          <PanelHost />
          <MapClickFloatingCard />
          <TopRightControls />
          <StreetViewViewer />
          <div className="absolute bottom-[calc(1rem+var(--omx-safe-bottom))] left-1/2 -translate-x-1/2 z-10 flex flex-col-reverse items-center gap-2 pointer-events-none [&>*]:pointer-events-auto">
            {/* All legends/toolbars loaded dynamically by LegendHost */}
            <LegendHost />
          </div>
          <LayerSelector />
          <MapControls />
          <MapFooter />
          <Suspense>
            <DeepLinkManager />
          </Suspense>
          <Suspense>
            <ShareIntentHandler />
          </Suspense>
        </div>
      </ElevationHoverProvider>
    </MapProvider>
  );
}
