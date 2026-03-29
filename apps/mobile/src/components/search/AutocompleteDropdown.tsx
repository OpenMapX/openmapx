import { MaterialIcons } from "@expo/vector-icons";
import type { AutocompleteResult } from "@openmapx/core";
import { isTransitName } from "@openmapx/core";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { Divider, Text, useTheme } from "react-native-paper";

const TEAL = "#007b8b";

interface AutocompleteDropdownProps {
  suggestions: AutocompleteResult[];
  onSelect: (result: AutocompleteResult) => void;
}

type IconName = keyof typeof MaterialIcons.glyphMap;

const LABELED_PLACE_ICONS: Record<string, IconName> = {
  home: "home",
  work: "work",
};

const TYPE_ICONS: Record<AutocompleteResult["type"], IconName> = {
  address: "location-on",
  poi: "search",
  street: "location-on",
  region: "location-on",
  category: "category",
  transit_stop: "directions-transit",
  labeled_place: "flag",
};

const TEAL_TYPES = new Set<AutocompleteResult["type"]>([
  "category",
  "transit_stop",
  "labeled_place",
]);

function getResultIcon(s: AutocompleteResult): { name: IconName; color: string } {
  if (s.type === "labeled_place" && s.labelKey) {
    const icon = LABELED_PLACE_ICONS[s.labelKey];
    if (icon) return { name: icon, color: TEAL };
  }

  // Detect transit stop by keywords in label/sublabel
  const text = `${s.label} ${s.sublabel ?? ""}`.toLowerCase();
  if (s.type !== "category" && isTransitName(text)) {
    return { name: "directions-transit", color: TEAL };
  }

  return {
    name: TYPE_ICONS[s.type] ?? "location-on",
    color: TEAL_TYPES.has(s.type) ? TEAL : "#666",
  };
}

function SuggestionRow({
  item,
  index,
  onSelect,
}: {
  item: AutocompleteResult;
  index: number;
  onSelect: (result: AutocompleteResult) => void;
}) {
  const theme = useTheme();
  const icon = getResultIcon(item);

  return (
    <>
      {index > 0 && <Divider />}
      <Pressable
        testID={`autocomplete-item-${index}`}
        onPress={() => onSelect(item)}
        style={({ pressed }) => [
          styles.row,
          pressed && { backgroundColor: theme.colors.surfaceVariant },
        ]}
        accessibilityRole="button"
        accessibilityLabel={item.label}
      >
        <View style={styles.iconContainer}>
          <MaterialIcons name={icon.name} size={20} color={icon.color} />
        </View>
        <View style={styles.textContainer}>
          <Text variant="bodyMedium" numberOfLines={1} style={styles.label}>
            {item.label}
          </Text>
          {item.sublabel ? (
            <Text
              variant="bodySmall"
              numberOfLines={1}
              style={[styles.sublabel, { color: theme.colors.onSurfaceVariant }]}
            >
              {item.sublabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </>
  );
}

export function AutocompleteDropdown({ suggestions, onSelect }: AutocompleteDropdownProps) {
  if (suggestions.length === 0) return null;

  return (
    <View testID="autocomplete-list" style={styles.container}>
      <FlatList
        data={suggestions}
        keyExtractor={(item, i) => `${item.id}-${item.type}-${item.sublabel ?? i}`}
        renderItem={({ item, index }) => (
          <SuggestionRow item={item} index={index} onSelect={onSelect} />
        )}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 320,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  iconContainer: {
    width: 32,
    alignItems: "center",
    marginRight: 12,
  },
  textContainer: {
    flex: 1,
  },
  label: {
    fontSize: 14,
  },
  sublabel: {
    fontSize: 12,
    marginTop: 1,
  },
});
