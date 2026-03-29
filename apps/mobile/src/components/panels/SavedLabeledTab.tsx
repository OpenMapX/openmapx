import { MaterialIcons } from "@expo/vector-icons";
import type { LabeledPlace } from "@openmapx/core";
import { useDeleteLabel, useLabeledPlaces, usePlaceStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { ActivityIndicator, IconButton, Menu, Text, useTheme } from "react-native-paper";
import { useMap } from "@/lib/MapContext";

const TEAL = "#007b8b";

interface PlaceholderLabel {
  key: "home" | "work";
  icon: keyof typeof MaterialIcons.glyphMap;
}

const PLACEHOLDER_LABELS: PlaceholderLabel[] = [
  { key: "home", icon: "home" },
  { key: "work", icon: "work" },
];

export function SavedLabeledTab() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { flyTo } = useMap();
  const { data: labels, isLoading } = useLabeledPlaces();
  const deleteLabelMutation = useDeleteLabel();
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuLabel, setMenuLabel] = useState<LabeledPlace | null>(null);

  const handleLabelClick = useCallback(
    (label: LabeledPlace) => {
      setSelectedPlace({
        id: label.placeId ?? `label:${label.id}`,
        name: label.name,
        address: label.address ?? "",
        coordinates: [label.lng, label.lat],
      });
      flyTo([label.lng, label.lat], 15);
      router.push(`/place/${encodeURIComponent(label.placeId ?? `label:${label.id}`)}`);
    },
    [setSelectedPlace, flyTo, router],
  );

  const handleMenuOpen = useCallback((label: LabeledPlace) => {
    setMenuLabel(label);
    setMenuVisible(true);
  }, []);

  const handleMenuClose = useCallback(() => {
    setMenuVisible(false);
    setMenuLabel(null);
  }, []);

  const handleRemove = useCallback(() => {
    if (menuLabel) {
      deleteLabelMutation.mutate(menuLabel.label);
    }
    handleMenuClose();
  }, [menuLabel, deleteLabelMutation, handleMenuClose]);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={TEAL} />
      </View>
    );
  }

  const homeLabel = labels?.find((l) => l.label.toLowerCase() === "home");
  const workLabel = labels?.find((l) => l.label.toLowerCase() === "work");
  const customLabels = labels?.filter(
    (l) => l.label.toLowerCase() !== "home" && l.label.toLowerCase() !== "work",
  );

  return (
    <View style={styles.container}>
      {PLACEHOLDER_LABELS.map(({ key, icon }) => {
        const dbLabel = key === "home" ? homeLabel : workLabel;
        return (
          <Pressable
            key={key}
            onPress={dbLabel ? () => handleLabelClick(dbLabel) : undefined}
            disabled={!dbLabel}
            style={({ pressed }) => [
              styles.labelRow,
              pressed && dbLabel && { backgroundColor: theme.colors.surfaceVariant },
            ]}
          >
            <MaterialIcons name={icon} size={22} color={TEAL} />
            <View style={styles.labelContent}>
              <Text variant="bodyMedium" style={styles.labelTitle}>
                {t(`saved.${key}`)}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
                numberOfLines={1}
              >
                {dbLabel?.address ?? t("saved.notSet")}
              </Text>
            </View>
            {dbLabel && (
              <Menu
                visible={menuVisible && menuLabel?.id === dbLabel.id}
                onDismiss={handleMenuClose}
                anchor={
                  <IconButton
                    icon={({ size, color }) => (
                      <MaterialIcons name="more-vert" size={size} color={color} />
                    )}
                    size={20}
                    onPress={() => handleMenuOpen(dbLabel)}
                  />
                }
              >
                <Menu.Item
                  leadingIcon={({ size, color }) => (
                    <MaterialIcons name="delete" size={size} color={color} />
                  )}
                  title={t("saved.removeAddress")}
                  onPress={handleRemove}
                />
              </Menu>
            )}
          </Pressable>
        );
      })}

      {customLabels?.map((label) => (
        <Pressable
          key={label.id}
          onPress={() => handleLabelClick(label)}
          style={({ pressed }) => [
            styles.labelRow,
            pressed && { backgroundColor: theme.colors.surfaceVariant },
          ]}
        >
          <MaterialIcons name="flag" size={22} color={TEAL} />
          <View style={styles.labelContent}>
            <Text variant="bodyMedium" style={styles.labelTitle}>
              {label.label}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant }}
              numberOfLines={1}
            >
              {label.address ?? t("saved.notSet")}
            </Text>
          </View>
          <Menu
            visible={menuVisible && menuLabel?.id === label.id}
            onDismiss={handleMenuClose}
            anchor={
              <IconButton
                icon={({ size, color }) => (
                  <MaterialIcons name="more-vert" size={size} color={color} />
                )}
                size={20}
                onPress={() => handleMenuOpen(label)}
              />
            }
          >
            <Menu.Item
              leadingIcon={({ size, color }) => (
                <MaterialIcons name="delete" size={size} color={color} />
              )}
              title={t("saved.removeAddress")}
              onPress={handleRemove}
            />
          </Menu>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  loadingContainer: {
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  labelContent: {
    flex: 1,
    minWidth: 0,
  },
  labelTitle: {
    fontWeight: "500",
  },
});
