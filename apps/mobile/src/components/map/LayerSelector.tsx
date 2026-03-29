import { MaterialIcons } from "@expo/vector-icons";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import type { MapLayer } from "@openmapx/core";
import {
  useAirQualityStore,
  useBuildingsStore,
  useCyclingStore,
  useEarthquakeStore,
  useHikingStore,
  useLayerStore,
  useLiveTrainsStore,
  useMeasurementStore,
  useStreetViewStore,
  useTrafficStore,
  useTransitStore,
  useTravelTimeStore,
  useWildfireStore,
  useWinterSportsStore,
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
  labelKey: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  useStore: () => { layerVisible: boolean; setLayerVisible: (v: boolean) => void };
}

const BASE_LAYERS: BaseLayerOption[] = [
  { id: "default", labelKey: "layers.default", icon: "map" },
  { id: "satellite", labelKey: "layers.satellite", icon: "satellite-alt" },
  { id: "terrain", labelKey: "layers.terrain", icon: "terrain" },
  { id: "cycling", labelKey: "layers.cycling", icon: "pedal-bike" },
];

const OVERLAY_OPTIONS: OverlayOption[] = [
  {
    labelKey: "layers.traffic",
    icon: "traffic",
    useStore: () => {
      const layerVisible = useTrafficStore((s) => s.layerVisible);
      const setLayerVisible = useTrafficStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.transit",
    icon: "directions-transit",
    useStore: () => {
      const layerVisible = useTransitStore((s) => s.layerVisible);
      const setLayerVisible = useTransitStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.3dBuildings",
    icon: "location-city",
    useStore: () => {
      const layerVisible = useBuildingsStore((s) => s.layerVisible);
      const setLayerVisible = useBuildingsStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.streetLevelImagery",
    icon: "streetview",
    useStore: () => {
      const layerVisible = useStreetViewStore((s) => s.layerVisible);
      const setLayerVisible = useStreetViewStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.airQuality",
    icon: "air",
    useStore: () => {
      const layerVisible = useAirQualityStore((s) => s.layerVisible);
      const setLayerVisible = useAirQualityStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.earthquakes",
    icon: "public",
    useStore: () => {
      const layerVisible = useEarthquakeStore((s) => s.layerVisible);
      const setLayerVisible = useEarthquakeStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.wildfires",
    icon: "local-fire-department",
    useStore: () => {
      const layerVisible = useWildfireStore((s) => s.layerVisible);
      const setLayerVisible = useWildfireStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.liveTrains",
    icon: "train",
    useStore: () => {
      const layerVisible = useLiveTrainsStore((s) => s.layerVisible);
      const setLayerVisible = useLiveTrainsStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.winterSports",
    icon: "downhill-skiing",
    useStore: () => {
      const layerVisible = useWinterSportsStore((s) => s.layerVisible);
      const setLayerVisible = useWinterSportsStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.hiking",
    icon: "hiking",
    useStore: () => {
      const layerVisible = useHikingStore((s) => s.layerVisible);
      const setLayerVisible = useHikingStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
  {
    labelKey: "layers.cycling",
    icon: "pedal-bike",
    useStore: () => {
      const layerVisible = useCyclingStore((s) => s.layerVisible);
      const setLayerVisible = useCyclingStore((s) => s.setLayerVisible);
      return { layerVisible, setLayerVisible };
    },
  },
];

function OverlayToggle({ option }: { option: OverlayOption }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { layerVisible, setLayerVisible } = option.useStore();

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
            {OVERLAY_OPTIONS.map((option) => (
              <OverlayToggle key={option.labelKey} option={option} />
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
