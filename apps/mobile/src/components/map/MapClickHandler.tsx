import { MaterialIcons } from "@expo/vector-icons";
import type { LngLat } from "@openmapx/core";
import { useMapClickStore, usePlaceStore, useReverseGeocoding } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Surface, Text, useTheme } from "react-native-paper";

/**
 * Floating card that appears at the bottom of the screen when the user taps
 * on empty map space. Shows the reverse-geocoded address and lets the user
 * open place detail.
 */
export function MapClickHandler() {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const clickedLngLat = useMapClickStore((s) => s.clickedLngLat);
  const setClickedLngLat = useMapClickStore((s) => s.setClickedLngLat);
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { data: reverseResult, isLoading } = useReverseGeocoding(clickedLngLat);

  // Clear clicked point when a place is selected externally
  useEffect(() => {
    if (selectedPlace) setClickedLngLat(null);
  }, [selectedPlace, setClickedLngLat]);

  if (!clickedLngLat) return null;

  const coordLabel = formatCoords(clickedLngLat);
  const address = reverseResult?.address;

  const handleOpenPlace = () => {
    const name = address ?? coordLabel;
    setSelectedPlace({
      id: `lnglat:${clickedLngLat[0]},${clickedLngLat[1]}`,
      name,
      address: address ?? coordLabel,
      coordinates: clickedLngLat,
    });
    setClickedLngLat(null);
    router.push(`/place/${encodeURIComponent(`lnglat:${clickedLngLat[0]},${clickedLngLat[1]}`)}`);
  };

  const handleDismiss = () => {
    setClickedLngLat(null);
  };

  return (
    <View style={styles.container} pointerEvents="box-none">
      <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={3}>
        <Pressable onPress={handleOpenPlace} style={styles.cardInner}>
          <View style={styles.iconCol}>
            <MaterialIcons name="place" size={24} color={theme.colors.onSurfaceVariant} />
          </View>
          <View style={styles.textCol}>
            {isLoading ? (
              <ActivityIndicator size="small" />
            ) : (
              <>
                <Text
                  variant="bodyMedium"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurface }}
                >
                  {address ?? t("map.droppedPin", { defaultValue: "Dropped pin" })}
                </Text>
                <Text
                  variant="bodySmall"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {coordLabel}
                </Text>
              </>
            )}
          </View>
          <Pressable
            onPress={handleDismiss}
            hitSlop={8}
            accessibilityLabel={t("common.close", { defaultValue: "Close" })}
          >
            <MaterialIcons name="close" size={20} color={theme.colors.onSurfaceVariant} />
          </Pressable>
        </Pressable>
      </Surface>
    </View>
  );
}

function formatCoords(lngLat: LngLat): string {
  return `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`;
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 80,
    left: 16,
    right: 16,
    alignItems: "center",
  },
  card: {
    borderRadius: 12,
    overflow: "hidden",
    width: "100%",
    maxWidth: 360,
  },
  cardInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 10,
  },
  iconCol: {
    width: 28,
    alignItems: "center",
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
});
