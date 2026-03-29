import { useMergedPlace, usePlaceStore } from "@openmapx/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { PlaceDetailContent } from "@/components/panels/PlaceDetailContent";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function PlaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);

  // If navigated to this route but no place is selected yet,
  // create a minimal place from the route param to trigger enrichment
  useEffect(() => {
    const current = usePlaceStore.getState().selectedPlace;
    if (!current && id) {
      setSelectedPlace({
        id: decodeURIComponent(id),
        name: "",
        address: "",
        coordinates: [0, 0],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, setSelectedPlace]);

  const { place, isLoading } = useMergedPlace(selectedPlace);

  const handleDismiss = () => {
    setSelectedPlace(null);
    if (router.canGoBack()) {
      router.back();
    }
  };

  return (
    <BottomSheetWrapper
      snapPoints={["30%", "60%", "95%"]}
      initialSnap={1}
      onDismiss={handleDismiss}
    >
      {place ? (
        <PlaceDetailContent place={place} isLoading={isLoading} />
      ) : (
        <View style={styles.loading}>
          <ActivityIndicator size="large" />
        </View>
      )}
    </BottomSheetWrapper>
  );
}

const styles = StyleSheet.create({
  loading: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
