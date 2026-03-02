import { MapCanvas } from "@/components/map/MapCanvas";
import { MapControls } from "@/components/map/MapControls";
import { TopRightControls } from "@/components/map/TopRightControls";
import { UserLocationMarker } from "@/components/map/UserLocationMarker";
import { SearchBar } from "@/components/search/SearchBar";
import { MapProvider } from "@/lib/MapContext";

export default function HomePage() {
  return (
    <MapProvider>
      <div className="relative w-full h-dvh overflow-hidden">
        <MapCanvas />
        <UserLocationMarker />
        <SearchBar />
        <TopRightControls />
        <MapControls />
      </div>
    </MapProvider>
  );
}
