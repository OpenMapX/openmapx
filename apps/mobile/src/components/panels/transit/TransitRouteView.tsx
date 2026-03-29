import { MaterialIcons } from "@expo/vector-icons";
import type { TripItinerary, TripLeg } from "@openmapx/core";
import { formatDistance, formatDuration, useVehicleJourney } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";

const TEAL = "#007b8b";

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function LegBadge({ leg }: { leg: TripLeg }) {
  if (leg.mode === "walking") {
    return <MaterialIcons name="directions-walk" size={16} color="#888" />;
  }
  if (leg.route) {
    return (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        mode={leg.mode}
        size="small"
      />
    );
  }
  return <MaterialIcons name="directions-bus" size={16} color="#888" />;
}

export function LegRemarks({ tripId }: { tripId: string }) {
  const { data: journey } = useVehicleJourney(tripId);
  if (!journey?.remarks?.length) return null;
  return (
    <View style={styles.legRemarksContainer}>
      {journey.remarks.map((remark, i) => (
        <RemarkChip key={`remark-${remark.text?.slice(0, 20) ?? i}`} remark={remark} inline />
      ))}
    </View>
  );
}

export function TransitLiveBadge({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const { data: journey } = useVehicleJourney(tripId);
  const hasRealtime = journey?.stops?.some((s) => s.delaySeconds !== undefined);
  if (!hasRealtime) return null;
  return (
    <View style={styles.liveBadge}>
      <View style={styles.liveDot} />
      <Text style={styles.liveText}>{t("common.live")}</Text>
    </View>
  );
}

export function LiveStopTime({
  scheduledTime,
  tripId,
  stopId,
}: {
  scheduledTime: string;
  tripId?: string;
  stopId?: string;
}) {
  const { data: journey } = useVehicleJourney(tripId ?? null);
  const stop = stopId ? journey?.stops.find((s) => s.stopId === stopId) : undefined;
  const delayMin = stop ? Math.round((stop.delaySeconds ?? 0) / 60) : 0;
  const hasDelay = delayMin > 0;

  const displayTime =
    hasDelay && stop
      ? formatTime(
          stop.expectedDeparture ??
            stop.expectedArrival ??
            stop.scheduledDeparture ??
            stop.scheduledArrival ??
            scheduledTime,
        )
      : scheduledTime;

  return (
    <View>
      <Text style={[styles.stopTimeText, hasDelay && styles.stopTimeDelayed]}>{displayTime}</Text>
      {hasDelay && <Text style={styles.stopTimeDelay}>+{delayMin}m</Text>}
    </View>
  );
}

interface TransitItineraryCardProps {
  itinerary: TripItinerary;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
}

export function TransitItineraryCard({
  itinerary,
  active,
  onSelect,
  onDetails,
}: TransitItineraryCardProps) {
  const { t } = useTranslation();
  const startTime = formatTime(itinerary.startTime);
  const endTime = formatTime(itinerary.endTime);

  return (
    <Pressable
      onPress={onSelect}
      style={[
        styles.card,
        {
          borderLeftColor: active ? TEAL : "transparent",
          backgroundColor: active ? "rgba(0,123,139,0.04)" : "transparent",
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <MaterialIcons name="directions-transit" size={18} color={active ? TEAL : "#bbb"} />
          <Text style={styles.cardTimeText}>
            {startTime} – {endTime}
          </Text>
        </View>
        <Text style={[styles.cardDuration, { color: active ? TEAL : "#333" }]}>
          {formatDuration(itinerary.duration)}
        </Text>
      </View>

      <View style={styles.legSummary}>
        {itinerary.legs.map((leg, i) => (
          <View key={`leg-${leg.mode}-${leg.from.name}-${leg.to.name}`} style={styles.legItem}>
            {i > 0 && <MaterialIcons name="chevron-right" size={14} color="#bbb" />}
            <LegBadge leg={leg} />
          </View>
        ))}
      </View>

      {itinerary.transfers > 0 && (
        <Text style={styles.transfersText}>
          {t("directions.transfers", { count: itinerary.transfers })}
          {itinerary.walkDistance > 0 &&
            ` · ${t("directions.walkDistance", { distance: formatDistance(itinerary.walkDistance) })}`}
        </Text>
      )}

      {active && (
        <Pressable onPress={onDetails} style={styles.detailsButton}>
          <Text style={styles.detailsButtonText}>{t("common.details")}</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderLeftWidth: 4,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  cardTimeText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  cardDuration: {
    fontSize: 14,
    fontWeight: "600",
  },
  legSummary: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 6,
  },
  legItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  transfersText: {
    fontSize: 12,
    color: "#888",
    marginTop: 4,
  },
  detailsButton: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  detailsButtonText: {
    fontSize: 12,
    fontWeight: "500",
    color: TEAL,
  },
  legRemarksContainer: {
    marginTop: 4,
    gap: 2,
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: `${TEAL}1a`,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "#4caf50",
  },
  liveText: {
    fontSize: 10,
    fontWeight: "600",
    color: TEAL,
  },
  stopTimeText: {
    fontSize: 12,
    color: "#888",
  },
  stopTimeDelayed: {
    color: "#d32f2f",
  },
  stopTimeDelay: {
    fontSize: 10,
    fontWeight: "600",
    color: "#d32f2f",
  },
});
