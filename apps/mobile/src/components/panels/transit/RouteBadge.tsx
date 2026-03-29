import type { TransportMode } from "@openmapx/core";
import { MODE_COLORS } from "@openmapx/core";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

function expandHex(hex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  return hex.startsWith("#") ? hex : `#${hex}`;
}

function contrastText(hex: string): string {
  const full = expandHex(hex);
  const r = Number.parseInt(full.slice(1, 3), 16);
  const g = Number.parseInt(full.slice(3, 5), 16);
  const b = Number.parseInt(full.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return "#000";
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000" : "#fff";
}

interface RouteBadgeProps {
  shortName: string;
  color?: string;
  textColor?: string;
  mode: TransportMode;
  size?: "small" | "medium";
  onPress?: () => void;
}

export function RouteBadge({
  shortName,
  color,
  textColor,
  mode,
  size = "small",
  onPress,
}: RouteBadgeProps) {
  const bg = color && color !== "" ? `#${color.replace("#", "")}` : MODE_COLORS[mode];
  const fg = textColor && textColor !== "" ? `#${textColor.replace("#", "")}` : contrastText(bg);

  const pill = (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: bg,
          height: size === "small" ? 22 : 26,
          paddingHorizontal: size === "small" ? 6 : 8,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: fg,
            fontSize: size === "small" ? 11 : 13,
          },
        ]}
        numberOfLines={1}
      >
        {shortName}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
        {pill}
      </Pressable>
    );
  }

  return pill;
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontWeight: "700",
    lineHeight: 16,
  },
});
