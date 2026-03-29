import { useDataSourceStore, useMapStore } from "@openmapx/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect } from "react";
import { DataSourcePanel } from "@/components/panels/DataSourcePanel";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function DataSourceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);
  const setSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setViewport = useDataSourceStore((s) => s.setViewport);
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);

  // Ensure data source is activated when navigating directly to this route
  useEffect(() => {
    if (id && !activeSource) {
      setActiveSource(id);
      const delta = 360 / 2 ** zoom;
      const bbox = {
        west: center[0] - delta / 2,
        south: center[1] - delta / 2,
        east: center[0] + delta / 2,
        north: center[1] + delta / 2,
      };
      setSearchBbox(bbox);
      setViewport(bbox, zoom);
    }
  }, [id, activeSource, setActiveSource, setSearchBbox, setViewport, center, zoom]);

  const handleDismiss = useCallback(() => {
    setActiveSource(null);
    if (router.canGoBack()) {
      router.back();
    }
  }, [setActiveSource, router]);

  return (
    <BottomSheetWrapper
      snapPoints={["30%", "60%", "95%"]}
      initialSnap={1}
      onDismiss={handleDismiss}
    >
      <DataSourcePanel />
    </BottomSheetWrapper>
  );
}
