import { useDirectionsStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback } from "react";
import { DirectionsPanelContent } from "@/components/panels/DirectionsPanelContent";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function DirectionsScreen() {
  const router = useRouter();
  const close = useDirectionsStore((s) => s.close);

  const handleDismiss = useCallback(() => {
    close();
    if (router.canGoBack()) {
      router.back();
    }
  }, [close, router]);

  return (
    <BottomSheetWrapper snapPoints={["40%", "95%"]} initialSnap={1} onDismiss={handleDismiss}>
      <DirectionsPanelContent />
    </BottomSheetWrapper>
  );
}
