import { MaterialIcons } from "@expo/vector-icons";
import type { Waypoint } from "@openmapx/core";
import * as Haptics from "expo-haptics";
import { ImpactFeedbackStyle } from "expo-haptics";
import type { TFunction } from "i18next";
import { Pressable, StyleSheet, View } from "react-native";
import DraggableFlatList, {
  type RenderItemParams,
  ScaleDecorator,
} from "react-native-draggable-flatlist";
import { IconButton, Text } from "react-native-paper";
import { WaypointRow } from "./WaypointRow";

const _TEAL = "#007b8b";
const MAX_WAYPOINTS = 10;

interface WaypointListProps {
  waypoints: Waypoint[];
  inputValues: string[];
  onInputChange: (index: number, value: string) => void;
  onFocus: (index: number) => void;
  onBlur: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onAdd: (afterIndex: number) => void;
  onRemove: (index: number) => void;
  onReverse: () => void;
  onUseMyLocation?: () => void;
  isTransitMode: boolean;
  t: TFunction;
}

export function WaypointList({
  waypoints,
  inputValues,
  onInputChange,
  onFocus,
  onBlur,
  onReorder,
  onAdd,
  onRemove,
  onReverse,
  onUseMyLocation,
  isTransitMode,
  t,
}: WaypointListProps) {
  const canAddMore = waypoints.length < MAX_WAYPOINTS && !isTransitMode;

  const renderItem = ({ item, getIndex, drag, isActive }: RenderItemParams<Waypoint>) => {
    const i = getIndex() ?? 0;
    return (
      <ScaleDecorator>
        <WaypointRow
          waypoint={item}
          index={i}
          total={waypoints.length}
          inputValue={inputValues[i] ?? ""}
          onInputChange={(v) => onInputChange(i, v)}
          onFocus={() => onFocus(i)}
          onBlur={onBlur}
          onRemove={() => onRemove(i)}
          onUseMyLocation={onUseMyLocation}
          placeholder={
            i === 0
              ? t("directions.chooseOrigin")
              : i === waypoints.length - 1
                ? t("directions.chooseDestination")
                : `${t("directions.addStop")} ${i}`
          }
          isActive={isActive}
          drag={drag}
        />
      </ScaleDecorator>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.listCol}>
          <DraggableFlatList
            data={waypoints}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            onDragBegin={() => {
              Haptics.impactAsync(ImpactFeedbackStyle.Light);
            }}
            onDragEnd={({ from, to }) => {
              if (from !== to) onReorder(from, to);
            }}
            scrollEnabled={false}
          />
        </View>

        {/* Swap / reverse button */}
        <View style={styles.swapCol}>
          <IconButton
            icon={({ size }) => <MaterialIcons name="swap-vert" size={size} color="#666" />}
            size={22}
            onPress={onReverse}
          />
        </View>
      </View>

      {/* Add stop button */}
      {canAddMore && (
        <Pressable onPress={() => onAdd(waypoints.length - 2)} style={styles.addButton}>
          <MaterialIcons
            name="add-circle-outline"
            size={18}
            color="#666"
            style={{ marginLeft: 24 }}
          />
          <Text style={styles.addText}>{t("directions.addStop")}</Text>
        </Pressable>
      )}

      {/* Transit multi-stop warning */}
      {isTransitMode && waypoints.length > 2 && (
        <Text style={styles.warningText}>{t("directions.multiStopTransitUnavailable")}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 4,
  },
  listCol: {
    flex: 1,
    gap: 4,
  },
  swapCol: {
    alignItems: "center",
    justifyContent: "center",
  },
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 4,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  addText: {
    fontSize: 14,
    color: "#666",
  },
  warningText: {
    fontSize: 12,
    color: "#888",
    marginTop: 4,
    paddingHorizontal: 24,
  },
});
