import { useSavedPlacesStore } from "@openmapx/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect } from "react";
import { SavedListDetail } from "@/components/panels/SavedListDetail";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function SavedListScreen() {
  const { listId } = useLocalSearchParams<{ listId: string }>();
  const router = useRouter();
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const selectList = useSavedPlacesStore((s) => s.selectList);
  const clearSelectedList = useSavedPlacesStore((s) => s.clearSelectedList);

  // Ensure the list is selected when navigating directly to this route
  useEffect(() => {
    if (listId && selectedListId !== listId) {
      selectList(listId);
    }
  }, [listId, selectedListId, selectList]);

  const handleDismiss = useCallback(() => {
    clearSelectedList();
    if (router.canGoBack()) {
      router.back();
    }
  }, [clearSelectedList, router]);

  if (!listId) return null;

  return (
    <BottomSheetWrapper
      snapPoints={["30%", "60%", "95%"]}
      initialSnap={1}
      onDismiss={handleDismiss}
    >
      <SavedListDetail listId={listId} />
    </BottomSheetWrapper>
  );
}
