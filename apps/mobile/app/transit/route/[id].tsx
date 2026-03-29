import { usePlaceStore } from "@openmapx/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { LineDetail } from "@/components/panels/transit/LineDetail";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function TransitRouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const routeId = id ? decodeURIComponent(id) : null;
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const setActiveRouteId = usePlaceStore((s) => s.setActiveRouteId);

  const handleDismiss = () => {
    setActiveRouteId(null);
    if (router.canGoBack()) {
      router.back();
    }
  };

  return (
    <BottomSheetWrapper snapPoints={["40%", "80%"]} initialSnap={1} onDismiss={handleDismiss}>
      {routeId ? (
        <LineDetail routeId={routeId} place={selectedPlace ?? undefined} onBack={handleDismiss} />
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
