import { useSavedPlacesStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback } from "react";
import { SavedPlacesContent } from "@/components/panels/SavedPlacesContent";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function SavedScreen() {
  const router = useRouter();
  const clearSelectedList = useSavedPlacesStore((s) => s.clearSelectedList);

  const handleDismiss = useCallback(() => {
    clearSelectedList();
    if (router.canGoBack()) {
      router.back();
    }
  }, [clearSelectedList, router]);

  return (
    <BottomSheetWrapper snapPoints={["60%", "95%"]} initialSnap={0} onDismiss={handleDismiss}>
      <SavedPlacesContent />
    </BottomSheetWrapper>
  );
}
