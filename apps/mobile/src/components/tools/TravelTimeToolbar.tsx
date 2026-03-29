import { MaterialIcons } from "@expo/vector-icons";
import type { IsochroneTravelMode, LngLat } from "@openmapx/core";
import { TRAVEL_TIME_PRESETS, useIsochrone, useTravelTimeStore } from "@openmapx/core";
import * as Location from "expo-location";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Chip, Divider, IconButton, Surface, Text, useTheme } from "react-native-paper";

function formatPresetLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}

const MODE_OPTIONS: {
  value: IsochroneTravelMode;
  icon: keyof typeof MaterialIcons.glyphMap;
  labelKey: string;
}[] = [
  { value: "driving", icon: "directions-car", labelKey: "travelTime.driving" },
  { value: "walking", icon: "directions-walk", labelKey: "travelTime.walking" },
  { value: "cycling", icon: "directions-bike", labelKey: "travelTime.cycling" },
];

export function TravelTimeToolbar() {
  const { t } = useTranslation();
  const theme = useTheme();
  const isActive = useTravelTimeStore((s) => s.isActive);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);
  const setMode = useTravelTimeStore((s) => s.setMode);
  const toggleMinutes = useTravelTimeStore((s) => s.toggleMinutes);
  const setOrigin = useTravelTimeStore((s) => s.setOrigin);
  const deactivate = useTravelTimeStore((s) => s.deactivate);

  const { isFetching } = useIsochrone({
    origin,
    mode,
    contourMinutes: selectedMinutes,
    enabled: isActive,
  });

  const handleMyLocation = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;

    const position = await Location.getCurrentPositionAsync({});
    const lngLat: LngLat = [position.coords.longitude, position.coords.latitude];
    setOrigin(lngLat);
  }, [setOrigin]);

  if (!isActive) return null;

  const presets = TRAVEL_TIME_PRESETS[mode];

  return (
    <View pointerEvents="box-none" style={styles.wrapper}>
      <Surface style={styles.container} elevation={3}>
        {/* Top row: mode selector + my location + status + close */}
        <View style={styles.topRow}>
          <View style={styles.modeToggle}>
            {MODE_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => setMode(opt.value)}
                accessibilityRole="button"
                accessibilityLabel={t(opt.labelKey)}
                style={[
                  styles.modeButton,
                  mode === opt.value && { backgroundColor: theme.colors.secondaryContainer },
                ]}
              >
                <MaterialIcons
                  name={opt.icon}
                  size={20}
                  color={mode === opt.value ? theme.colors.primary : theme.colors.onSurfaceVariant}
                />
              </Pressable>
            ))}
          </View>

          <IconButton
            icon={({ size, color }) => (
              <MaterialIcons name="my-location" size={size} color={color} />
            )}
            size={18}
            onPress={handleMyLocation}
            accessibilityLabel={t("travelTime.myLocation")}
            style={styles.actionButton}
          />

          <View style={styles.statusArea}>
            {isFetching ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <Text variant="labelSmall" style={styles.statusText}>
                {origin ? t("travelTime.dragToMove") : t("travelTime.clickToPlace")}
              </Text>
            )}
          </View>

          <IconButton
            icon={({ size, color }) => <MaterialIcons name="close" size={size} color={color} />}
            size={18}
            onPress={deactivate}
            accessibilityLabel={t("travelTime.close")}
            style={styles.actionButton}
          />
        </View>

        <Divider style={styles.horizontalDivider} />

        {/* Bottom row: time preset chips */}
        <View style={styles.chipsRow}>
          {presets.map((minutes) => {
            const selected = selectedMinutes.includes(minutes);
            return (
              <Chip
                key={minutes}
                compact
                selected={selected}
                onPress={() => toggleMinutes(minutes)}
                style={styles.timeChip}
                textStyle={[styles.timeChipText, selected && { fontWeight: "600" }]}
              >
                {formatPresetLabel(minutes)}
              </Chip>
            );
          })}
        </View>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 24,
    left: 12,
    right: 12,
    alignItems: "center",
  },
  container: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: 480,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  modeToggle: {
    flexDirection: "row",
    borderRadius: 8,
    overflow: "hidden",
  },
  modeButton: {
    width: 36,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  actionButton: {
    width: 32,
    height: 32,
    margin: 0,
  },
  statusArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: {
    textAlign: "center",
    opacity: 0.7,
  },
  horizontalDivider: {
    marginVertical: 6,
  },
  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "center",
  },
  timeChip: {
    height: 28,
  },
  timeChipText: {
    fontSize: 12,
  },
});
