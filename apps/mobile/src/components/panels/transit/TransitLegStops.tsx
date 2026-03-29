import { MaterialIcons } from "@expo/vector-icons";
import { useVehicleJourney } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

function formatStopTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface TransitLegStopsProps {
  tripId?: string;
  stopCount?: number;
  fromStopId?: string;
  toStopId?: string;
}

export function TransitLegStops({ tripId, stopCount, fromStopId, toStopId }: TransitLegStopsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { data: journey } = useVehicleJourney(tripId ?? null);

  if (!tripId) return null;

  const allStops = journey?.stops ?? [];
  const fromIdx = fromStopId ? allStops.findIndex((s) => s.stopId === fromStopId) : -1;
  const toIdx =
    fromIdx !== -1 && toStopId
      ? allStops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId)
      : toStopId
        ? allStops.findIndex((s) => s.stopId === toStopId)
        : -1;
  const legStops =
    fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx
      ? allStops.slice(fromIdx, toIdx + 1)
      : allStops;

  const intermediateStops = legStops.slice(1, -1);

  const rawCount = journey != null ? intermediateStops.length : stopCount;
  const count = rawCount != null ? rawCount + 1 : null;

  if (count == null) return null;

  const label = t("common.stopsCount", { count });
  const hasStops = journey != null && intermediateStops.length > 0;

  if (!hasStops) {
    return (
      <View style={styles.container}>
        <Text style={styles.countText}>{label}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable onPress={() => setExpanded((e) => !e)} style={styles.toggleRow}>
        <MaterialIcons name={expanded ? "expand-less" : "expand-more"} size={14} color="#888" />
        <Text style={styles.toggleLabel}>{label}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.stopsContainer}>
          {intermediateStops.map((stop) => {
            const time =
              stop.expectedDeparture ??
              stop.expectedArrival ??
              stop.scheduledDeparture ??
              stop.scheduledArrival;
            const timeStr = time ? formatStopTime(time) : "";
            const delaySec = stop.delaySeconds ?? 0;
            const delayMin = Math.round(delaySec / 60);

            return (
              <View key={`stop-${stop.stopId}`} style={styles.stopRow}>
                <View style={styles.timeCell}>
                  <Text style={[styles.timeText, delayMin > 0 && styles.delayedTime]}>
                    {timeStr}
                  </Text>
                  {delayMin > 0 && !stop.canceled && (
                    <Text style={styles.delayText}>+{delayMin}m</Text>
                  )}
                </View>
                <Text
                  style={[styles.stopName, stop.canceled && styles.canceledStop]}
                  numberOfLines={1}
                >
                  {stop.name}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 4,
  },
  countText: {
    fontSize: 12,
    color: "#999",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  toggleLabel: {
    fontSize: 12,
    color: "#888",
  },
  stopsContainer: {
    marginTop: 2,
    marginBottom: 2,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  timeCell: {
    width: 48,
    alignItems: "flex-end",
    flexShrink: 0,
  },
  timeText: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    color: "#333",
  },
  delayedTime: {
    color: "#d32f2f",
  },
  delayText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#d32f2f",
  },
  stopName: {
    fontSize: 12,
    color: "#888",
    flex: 1,
  },
  canceledStop: {
    color: "#d32f2f",
  },
});
