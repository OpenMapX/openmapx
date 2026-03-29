import { MaterialIcons } from "@expo/vector-icons";
import { useMapStore } from "@openmapx/core";
import * as Haptics from "expo-haptics";
import { ImpactFeedbackStyle } from "expo-haptics";
import * as Location from "expo-location";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Divider, IconButton, Surface, useTheme } from "react-native-paper";
import { useMap } from "@/lib/MapContext";

export function MapControls() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { flyTo, zoomIn, zoomOut, resetBearing } = useMap();
  const bearing = useMapStore((s) => s.bearing);
  const pitch = useMapStore((s) => s.pitch);
  const setUserLocation = useMapStore((s) => s.setUserLocation);

  const handleMyLocation = useCallback(async () => {
    Haptics.impactAsync(ImpactFeedbackStyle.Light);
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;

    const position = await Location.getCurrentPositionAsync({});
    const lngLat: [number, number] = [position.coords.longitude, position.coords.latitude];
    setUserLocation(lngLat);
    flyTo(lngLat, 14);
  }, [setUserLocation, flyTo]);

  const showCompass = Math.abs(bearing) > 0.5 || pitch > 0.5;

  return (
    <View style={styles.container} pointerEvents="box-none">
      {/* My Location */}
      <Surface style={styles.singleButton} elevation={2}>
        <IconButton
          icon={({ size, color }) => <MaterialIcons name="my-location" size={size} color={color} />}
          size={20}
          onPress={handleMyLocation}
          accessibilityLabel={t("map.goToMyLocationAriaLabel")}
          style={styles.iconButton}
          iconColor={theme.colors.primary}
        />
      </Surface>

      {/* Zoom in / Zoom out */}
      <Surface style={styles.zoomGroup} elevation={2}>
        <IconButton
          icon={({ size, color }) => <MaterialIcons name="add" size={size} color={color} />}
          size={20}
          onPress={zoomIn}
          accessibilityLabel={t("map.zoomInAriaLabel")}
          style={styles.iconButton}
        />
        <Divider style={styles.divider} />
        <IconButton
          icon={({ size, color }) => <MaterialIcons name="remove" size={size} color={color} />}
          size={20}
          onPress={zoomOut}
          accessibilityLabel={t("map.zoomOutAriaLabel")}
          style={styles.iconButton}
        />
      </Surface>

      {/* Compass — only when map is rotated */}
      {showCompass && (
        <Surface style={styles.compassButton} elevation={2}>
          <IconButton
            icon={({ size }) => (
              <MaterialIcons
                name="explore"
                size={size}
                color={theme.colors.error}
                style={{ transform: [{ rotate: `${-bearing}deg` }] }}
              />
            )}
            size={22}
            onPress={resetBearing}
            accessibilityLabel={t("map.resetBearingAriaLabel")}
            style={styles.iconButton}
          />
        </Surface>
      )}
    </View>
  );
}

const BUTTON_SIZE = 40;

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 48,
    right: 12,
    alignItems: "center",
    gap: 8,
  },
  singleButton: {
    borderRadius: 12,
    overflow: "hidden",
  },
  zoomGroup: {
    borderRadius: 12,
    overflow: "hidden",
  },
  compassButton: {
    borderRadius: 20,
    overflow: "hidden",
  },
  iconButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    margin: 0,
  },
  divider: {
    marginHorizontal: 6,
  },
});
