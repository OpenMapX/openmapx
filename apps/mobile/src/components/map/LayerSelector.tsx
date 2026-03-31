import { MaterialIcons } from "@expo/vector-icons";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import type { MapLayer } from "@openmapx/core";
import {
  getRegisteredOverlayStore,
  useIntegrationRegistry,
  useLayerStore,
  useMeasurementStore,
  useTravelTimeStore,
} from "@openmapx/core";
import * as Haptics from "expo-haptics";
import { ImpactFeedbackStyle } from "expo-haptics";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Surface, Text, useTheme } from "react-native-paper";

interface BaseLayerOption {
  id: MapLayer;
  labelKey: string;
  icon: keyof typeof MaterialIcons.glyphMap;
}

interface OverlayOption {
  overlayId: string;
  labelKey: string;
  icon: keyof typeof MaterialIcons.glyphMap;
}

const BASE_LAYERS: BaseLayerOption[] = [
  { id: "default", labelKey: "layers.default", icon: "map" },
  { id: "satellite", labelKey: "layers.satellite", icon: "satellite-alt" },
  { id: "terrain", labelKey: "layers.terrain", icon: "terrain" },
  { id: "cycling", labelKey: "layers.cycling", icon: "pedal-bike" },
];

const OVERLAY_ICON_MAP: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  traffic: "traffic",
  transit: "directions-transit",
  "3d-buildings": "location-city",
  "street-view": "streetview",
  "air-quality": "air",
  earthquakes: "public",
  wildfires: "local-fire-department",
  "live-trains": "train",
  "winter-sports": "downhill-skiing",
  hiking: "hiking",
  cycling: "pedal-bike",
};

function integrationIdToOverlayId(integrationId: string): string {
  if (integrationId === "overlay-traffic-tomtom") return "traffic";
  if (integrationId === "street-view-mapillary") return "street-view";
  return integrationId.replace(/^overlay-/, "").replace(/^tool-/, "");
}

function useOverlayOptions(): OverlayOption[] {
  const registry = useIntegrationRegistry();

  return useMemo(() => {
    const withLayerSelector = registry.getWithLayerSelector();
    const options: OverlayOption[] = [];

    for (const integration of withLayerSelector) {
      const ls = integration.frontend?.layerSelector;
      if (!ls || ls.group !== "map-details") continue;

      const overlayId = integrationIdToOverlayId(integration.id);
      const store = getRegisteredOverlayStore(overlayId);
      if (!store) continue;

      options.push({
        overlayId,
        labelKey: ls.labelKey,
        icon: OVERLAY_ICON_MAP[overlayId] ?? "layers",
      });
    }

    return options;
  }, [registry]);
}

function OverlayToggle({ option }: { option: OverlayOption }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const store = getRegisteredOverlayStore(option.overlayId);
  const layerVisible = store ? store((s) => s.layerVisible) : false;
  const setLayerVisible = store ? store((s) => s.setLayerVisible) : () => {};

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(ImpactFeedbackStyle.Light);
        setLayerVisible(!layerVisible);
      }}
      accessibilityRole="button"
      accessibilityLabel={t(option.labelKey)}
      style={styles.gridItem}
    >
      <Surface
        style={[
          styles.card,
          layerVisible && {
            borderColor: theme.colors.primary,
            borderWidth: 2,
          },
        ]}
        elevation={1}
      >
        <MaterialIcons
          name={option.icon}
          size={28}
          color={layerVisible ? theme.colors.primary : theme.colors.onSurface}
        />
      </Surface>
      <Text variant="labelSmall" numberOfLines={1} style={styles.cardLabel}>
        {t(option.labelKey)}
      </Text>
    </Pressable>
  );
}

export function LayerSelector() {
  const { t } = useTranslation();
  const theme = useTheme();
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const activateMeasurement = useMeasurementStore((s) => s.activate);
  const activateTravelTime = useTravelTimeStore((s) => s.activate);
  const snapPoints = useMemo(() => ["60%", "90%"], []);
  const overlayOptions = useOverlayOptions();

  const handleOpen = useCallback(() => {
    bottomSheetRef.current?.present();
  }, []);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  return (
    <>
      <Surface style={styles.fab} elevation={3}>
        <Pressable
          testID="layer-selector-button"
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={t("layers.openLayerMenu")}
          style={styles.fabInner}
        >
          <MaterialIcons name="layers" size={22} color={theme.colors.onSurface} />
        </Pressable>
      </Surface>

      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        enableDynamicSizing={false}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: theme.colors.surface }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.onSurfaceVariant }}
      >
        <BottomSheetScrollView testID="layer-selector-sheet" style={styles.sheetContent}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            {t("layers.mapType")}
          </Text>

          <View style={styles.grid}>
            {BASE_LAYERS.map((layer) => {
              const isActive = activeLayer === layer.id;
              return (
                <Pressable
                  key={layer.id}
                  testID={`layer-option-${layer.id}`}
                  onPress={() => {
                    Haptics.impactAsync(ImpactFeedbackStyle.Light);
                    setActiveLayer(layer.id);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t(layer.labelKey)}
                  style={styles.gridItem}
                >
                  <Surface
                    style={[
                      styles.card,
                      isActive && {
                        borderColor: theme.colors.primary,
                        borderWidth: 2,
                      },
                    ]}
                    elevation={1}
                  >
                    <MaterialIcons
                      name={layer.icon}
                      size={28}
                      color={isActive ? theme.colors.primary : theme.colors.onSurface}
                    />
                  </Surface>
                  <Text variant="labelSmall" numberOfLines={1} style={styles.cardLabel}>
                    {t(layer.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text variant="titleMedium" style={styles.sectionTitle}>
            {t("layers.mapDetails")}
          </Text>

          <View style={styles.grid}>
            {overlayOptions.map((option) => (
              <OverlayToggle key={option.overlayId} option={option} />
            ))}
          </View>

          <Text variant="titleMedium" style={styles.sectionTitle}>
            {t("layers.tools", { defaultValue: "Tools" })}
          </Text>

          <View style={styles.grid}>
            <Pressable
              onPress={() => {
                activateMeasurement();
                bottomSheetRef.current?.dismiss();
              }}
              accessibilityRole="button"
              accessibilityLabel={t("layers.measure")}
              style={styles.gridItem}
            >
              <Surface style={styles.card} elevation={1}>
                <MaterialIcons name="straighten" size={28} color={theme.colors.onSurface} />
              </Surface>
              <Text variant="labelSmall" numberOfLines={1} style={styles.cardLabel}>
                {t("layers.measure")}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                activateTravelTime();
                bottomSheetRef.current?.dismiss();
              }}
              accessibilityRole="button"
              accessibilityLabel={t("layers.travelTime")}
              style={styles.gridItem}
            >
              <Surface style={styles.card} elevation={1}>
                <MaterialIcons name="schedule" size={28} color={theme.colors.onSurface} />
              </Surface>
              <Text variant="labelSmall" numberOfLines={1} style={styles.cardLabel}>
                {t("layers.travelTime")}
              </Text>
            </Pressable>
          </View>
        </BottomSheetScrollView>
      </BottomSheetModal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    bottom: 120,
    left: 12,
    borderRadius: 12,
    overflow: "hidden",
  },
  fabInner: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  sectionTitle: {
    marginBottom: 12,
    marginTop: 4,
    fontWeight: "600",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 20,
  },
  gridItem: {
    alignItems: "center",
    width: 72,
  },
  card: {
    width: 64,
    height: 64,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  cardLabel: {
    marginTop: 4,
    textAlign: "center",
  },
});
