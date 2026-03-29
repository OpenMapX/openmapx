import { MaterialIcons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Text } from "react-native-paper";

const TEAL = "#007b8b";

const ICON_MAP: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  heart: "favorite",
  flag: "flag",
  star: "star",
  bookmark: "bookmark-border",
};

export function resolveListIcon(icon: string | null, size = 20): ReactNode {
  if (!icon) {
    return <MaterialIcons name="bookmark-border" size={size} color={TEAL} />;
  }
  if (icon.charCodeAt(0) > 127) {
    return <Text style={{ fontSize: size - 2 }}>{icon}</Text>;
  }
  const mapped = ICON_MAP[icon] ?? "bookmark-border";
  return <MaterialIcons name={mapped} size={size} color={TEAL} />;
}
