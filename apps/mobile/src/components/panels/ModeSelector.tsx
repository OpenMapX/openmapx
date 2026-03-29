import { MaterialIcons } from "@expo/vector-icons";
import type { TravelMode } from "@openmapx/core";
import * as Haptics from "expo-haptics";
import { ImpactFeedbackStyle } from "expo-haptics";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

const TEAL = "#007b8b";
const TEAL_LIGHT = "#e0f2f4";

interface ModeConfig {
  mode: TravelMode;
  icon: keyof typeof MaterialIcons.glyphMap;
  labelKey: string;
}

export const MODES: ModeConfig[] = [
  { mode: "driving", icon: "directions-car", labelKey: "driving" },
  { mode: "transit", icon: "directions-bus", labelKey: "transit" },
  { mode: "walking", icon: "directions-walk", labelKey: "walking" },
  { mode: "cycling", icon: "directions-bike", labelKey: "cycling" },
];

interface ModeSelectorProps {
  activeMode: TravelMode;
  onSelectMode: (mode: TravelMode) => void;
  getCachedTime: (mode: TravelMode) => string | undefined;
  loadingMode: TravelMode | null;
}

export function ModeSelector({
  activeMode,
  onSelectMode,
  getCachedTime,
  loadingMode,
}: ModeSelectorProps) {
  return (
    <View testID="mode-selector" style={styles.container}>
      {MODES.map(({ mode, icon }) => {
        const isActive = activeMode === mode;
        const timeStr = getCachedTime(mode);
        const isLoading = loadingMode === mode;

        return (
          <Pressable
            key={mode}
            onPress={() => {
              Haptics.impactAsync(ImpactFeedbackStyle.Light);
              onSelectMode(mode);
            }}
            style={styles.button}
            accessibilityRole="button"
          >
            <View
              style={[styles.iconPill, { backgroundColor: isActive ? TEAL_LIGHT : "transparent" }]}
            >
              <MaterialIcons name={icon} size={22} color={isActive ? TEAL : "#444"} />
            </View>
            <View style={styles.timeContainer}>
              {isLoading ? (
                <ActivityIndicator size={10} color="#999" />
              ) : (
                <Text
                  style={[styles.timeText, { color: isActive ? TEAL : "#666" }]}
                  numberOfLines={1}
                >
                  {timeStr ?? ""}
                </Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-around",
    flex: 1,
  },
  button: {
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 4,
    minWidth: 44,
  },
  iconPill: {
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  timeContainer: {
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  timeText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
