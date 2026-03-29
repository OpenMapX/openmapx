import { usePlaceStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { TripDetailView } from "@/components/panels/transit/TripDetailView";
import { BottomSheetWrapper } from "@/components/ui/BottomSheetWrapper";

export default function TransitTripScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const activeTripDep = usePlaceStore((s) => s.activeTripDep);
  const setActiveTripDep = usePlaceStore((s) => s.setActiveTripDep);

  const handleDismiss = () => {
    setActiveTripDep(null);
    if (router.canGoBack()) {
      router.back();
    }
  };

  return (
    <BottomSheetWrapper snapPoints={["40%", "80%"]} initialSnap={1} onDismiss={handleDismiss}>
      {activeTripDep ? (
        <TripDetailView departure={activeTripDep} onBack={handleDismiss} />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
            {t("transit.noTripSelected", "No trip selected")}
          </Text>
        </View>
      )}
    </BottomSheetWrapper>
  );
}

const styles = StyleSheet.create({
  empty: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 14,
  },
});
