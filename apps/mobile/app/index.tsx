import { useCategorySearchStore, useDataSourceStore } from "@openmapx/core";
import { View } from "react-native";
import { LayerSelector } from "@/components/map/LayerSelector";
import { AirQualityLegend } from "@/components/map/legends/AirQualityLegend";
import { CyclingLegend } from "@/components/map/legends/CyclingLegend";
import { EarthquakeLegend } from "@/components/map/legends/EarthquakeLegend";
import { HikingTrailsLegend } from "@/components/map/legends/HikingTrailsLegend";
import { StreetViewLegend } from "@/components/map/legends/StreetViewLegend";
import { WildfireLegend } from "@/components/map/legends/WildfireLegend";
import { WinterSportsLegend } from "@/components/map/legends/WinterSportsLegend";
import { MapClickHandler } from "@/components/map/MapClickHandler";
import { MapControls } from "@/components/map/MapControls";
import { MapFooter } from "@/components/map/MapFooter";
import { CategoryChips } from "@/components/search/CategoryChips";
import { CategoryFilterBar } from "@/components/search/CategoryFilterBar";
import { SearchBar } from "@/components/search/SearchBar";
import { MeasurementToolbar } from "@/components/tools/MeasurementToolbar";
import { TravelTimeToolbar } from "@/components/tools/TravelTimeToolbar";
import { SearchInAreaChip } from "@/components/ui/SearchInAreaChip";

export default function HomeScreen() {
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const showFilterBar = activeCategory !== null || activeSource === "fuel";

  return (
    <View pointerEvents="box-none" style={{ flex: 1 }}>
      <SearchBar />
      {showFilterBar ? <CategoryFilterBar /> : <CategoryChips />}
      <SearchInAreaChip />
      <MapFooter />
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          bottom: 80,
          left: 12,
          right: 12,
          alignItems: "center",
        }}
      >
        <StreetViewLegend />
        <AirQualityLegend />
        <EarthquakeLegend />
        <WildfireLegend />
        <CyclingLegend />
        <HikingTrailsLegend />
        <WinterSportsLegend />
      </View>
      <MapClickHandler />
      <MeasurementToolbar />
      <TravelTimeToolbar />
      <LayerSelector />
      <MapControls />
    </View>
  );
}
