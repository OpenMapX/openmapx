import { MaterialIcons } from "@expo/vector-icons";
import type { Departure, TripRemark } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { REMARK_PRIORITY, RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface DepartureRowProps {
  departure: Departure;
  showPlatform?: boolean;
  onPress?: (dep: Departure) => void;
  hasAlert?: boolean;
}

function topRemark(remarks: TripRemark[]): TripRemark {
  return [...remarks].sort((a, b) => REMARK_PRIORITY[b.type] - REMARK_PRIORITY[a.type])[0];
}

export function DepartureRow({
  departure,
  showPlatform = true,
  onPress,
  hasAlert = false,
}: DepartureRowProps) {
  const { t } = useTranslation();
  const isDelayed = departure.delaySeconds != null && departure.delaySeconds > 60;
  const isCanceled = departure.canceled === true;
  const hasRemarks = departure.remarks && departure.remarks.length > 0;

  const inner = (
    <View style={[styles.container, { opacity: isCanceled ? 0.5 : 1 }]}>
      <View style={styles.mainRow}>
        <View style={styles.leftContent}>
          <Text style={[styles.headsign, isCanceled && styles.lineThrough]} numberOfLines={1}>
            {departure.headsign}
          </Text>
          <View style={styles.badgeRow}>
            <RouteBadge
              shortName={departure.route.shortName}
              color={departure.route.color}
              mode={departure.route.mode}
            />
            {showPlatform && departure.platform && (
              <Text style={styles.platform}>
                {t("transit.platform")} {departure.platform}
              </Text>
            )}
            {hasAlert && <MaterialIcons name="warning-amber" size={14} color="#E65100" />}
          </View>
        </View>
        <View style={styles.timeColumn}>
          <Text
            style={[
              styles.scheduledTime,
              (isCanceled || isDelayed) && styles.lineThrough,
              isCanceled && styles.disabledText,
            ]}
          >
            {formatTime(departure.scheduledAt)}
          </Text>
          {isDelayed && !isCanceled && departure.expectedAt && (
            <Text style={styles.expectedTime}>{formatTime(departure.expectedAt)}</Text>
          )}
          {isCanceled && <Text style={styles.canceledText}>{t("transit.canceled")}</Text>}
        </View>
      </View>

      {hasRemarks && departure.remarks && (
        <View style={styles.remarksContainer}>
          {(onPress
            ? (() => {
                const urgent = departure.remarks?.filter((r) => r.type !== "info");
                return urgent.length > 0 ? [topRemark(urgent)] : [];
              })()
            : departure.remarks
          ).map((remark) => (
            <RemarkChip
              key={`remark-${remark.type}-${remark.text?.slice(0, 30) ?? ""}`}
              remark={remark}
              inline
            />
          ))}
        </View>
      )}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={() => onPress(departure)}
        style={({ pressed }) => [styles.pressable, pressed && styles.pressableActive]}
      >
        {inner}
      </Pressable>
    );
  }

  return <View style={styles.pressable}>{inner}</View>;
}

const styles = StyleSheet.create({
  pressable: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  pressableActive: {
    backgroundColor: "#f5f5f5",
  },
  container: {},
  mainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  leftContent: {
    flex: 1,
    minWidth: 0,
  },
  headsign: {
    fontSize: 14,
    fontWeight: "500",
    color: "#333",
  },
  lineThrough: {
    textDecorationLine: "line-through",
  },
  disabledText: {
    color: "#999",
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  platform: {
    fontSize: 12,
    color: "#888",
  },
  timeColumn: {
    alignItems: "flex-end",
    flexShrink: 0,
  },
  scheduledTime: {
    fontSize: 14,
    fontWeight: "500",
    color: "#333",
  },
  expectedTime: {
    fontSize: 14,
    fontWeight: "600",
    color: "#d32f2f",
  },
  canceledText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#d32f2f",
  },
  remarksContainer: {
    marginTop: 4,
    gap: 2,
  },
});
