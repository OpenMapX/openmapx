import { MaterialIcons } from "@expo/vector-icons";
import type { Waypoint } from "@openmapx/core";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { IconButton, Text, useTheme } from "react-native-paper";

const TEAL = "#007b8b";

interface WaypointRowProps {
  waypoint: Waypoint;
  index: number;
  total: number;
  inputValue: string;
  onInputChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onRemove: () => void;
  onUseMyLocation?: () => void;
  placeholder: string;
  isActive?: boolean;
  drag?: () => void;
}

export function WaypointRow({
  index,
  total,
  inputValue,
  onInputChange,
  onFocus,
  onBlur,
  onRemove,
  onUseMyLocation,
  placeholder,
  isActive,
  drag,
}: WaypointRowProps) {
  const theme = useTheme();
  const isOrigin = index === 0;
  const isDestination = index === total - 1;
  const canRemove = total > 2;

  return (
    <View style={[styles.row, isActive && styles.rowActive]}>
      {/* Marker icon */}
      <View style={styles.markerCol}>
        {isOrigin ? (
          <View style={styles.originDot} />
        ) : isDestination ? (
          <MaterialIcons name="location-on" size={18} color="#EA4335" />
        ) : (
          <View style={styles.waypointBadge}>
            <Text style={styles.waypointNumber}>{index}</Text>
          </View>
        )}
      </View>

      {/* Input */}
      <View style={styles.inputContainer}>
        <TextInput
          value={inputValue}
          onChangeText={onInputChange}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.onSurfaceVariant}
          returnKeyType="done"
          autoCorrect={false}
          autoCapitalize="none"
          style={[styles.input, { color: theme.colors.onSurface }]}
        />
        {isOrigin && onUseMyLocation && !inputValue && (
          <Pressable onPress={onUseMyLocation} hitSlop={8}>
            <MaterialIcons name="my-location" size={16} color={TEAL} />
          </Pressable>
        )}
      </View>

      {/* Remove button */}
      {canRemove && (
        <IconButton
          icon={({ size }) => <MaterialIcons name="close" size={size} color="#999" />}
          size={14}
          onPress={onRemove}
          style={styles.removeButton}
        />
      )}

      {/* Drag handle */}
      <Pressable onLongPress={drag} delayLongPress={150} style={styles.dragHandle}>
        <MaterialIcons name="drag-indicator" size={18} color="#bbb" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
  },
  rowActive: {
    opacity: 0.7,
    backgroundColor: "#f0f0f0",
    borderRadius: 8,
  },
  markerCol: {
    width: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  originDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#666",
    backgroundColor: "#fff",
  },
  waypointBadge: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: TEAL,
    alignItems: "center",
    justifyContent: "center",
  },
  waypointNumber: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  inputContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 8,
    backgroundColor: "#fafafa",
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
  },
  input: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  removeButton: {
    margin: 0,
    width: 28,
    height: 28,
  },
  dragHandle: {
    padding: 2,
  },
});
