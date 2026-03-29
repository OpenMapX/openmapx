import { useCategorySearchStore, useMapStore } from "@openmapx/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect } from "react";
import { CategoryResultsContent } from "@/components/panels/CategoryResultsContent";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function CategoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const setActiveCategory = useCategorySearchStore((s) => s.setActiveCategory);
  const setSearchBbox = useCategorySearchStore((s) => s.setSearchBbox);
  const clearCategory = useCategorySearchStore((s) => s.clearCategory);
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);

  // Ensure category is activated when navigating directly to this route
  useEffect(() => {
    if (id && !activeCategory) {
      setActiveCategory(id as Parameters<typeof setActiveCategory>[0]);
      // Set initial search bbox from current viewport
      const delta = 360 / 2 ** zoom;
      setSearchBbox({
        west: center[0] - delta / 2,
        south: center[1] - delta / 2,
        east: center[0] + delta / 2,
        north: center[1] + delta / 2,
      });
    }
  }, [id, activeCategory, setActiveCategory, setSearchBbox, center, zoom]);

  const handleDismiss = useCallback(() => {
    clearCategory();
    if (router.canGoBack()) {
      router.back();
    }
  }, [clearCategory, router]);

  return (
    <BottomSheetWrapper
      snapPoints={["30%", "60%", "95%"]}
      initialSnap={1}
      onDismiss={handleDismiss}
    >
      <CategoryResultsContent />
    </BottomSheetWrapper>
  );
}
