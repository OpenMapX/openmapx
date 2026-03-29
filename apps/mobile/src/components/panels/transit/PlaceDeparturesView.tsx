import { MaterialIcons } from "@expo/vector-icons";
import type { MergedDeparture, Place, TransportMode } from "@openmapx/core";
import {
  resolveProvider,
  useLinkedTransitAlerts,
  useLinkedTransitArrivals,
  useLinkedTransitDepartures,
  useProviders,
} from "@openmapx/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { DepartureRow } from "./DepartureRow";

const MODE_LABEL_KEYS: Partial<Record<TransportMode, string>> = {
  rail: "trains",
  subway: "subway",
  tram: "trams",
  bus: "buses",
  ferry: "ferries",
  gondola: "gondola",
  funicular: "funicular",
  cable_car: "cableCar",
  monorail: "monorail",
};

const TEAL = "#007b8b";

interface PlaceDeparturesViewProps {
  place: Place;
  onBack: () => void;
  modeFilter?: TransportMode | null;
  onDepartureClick: (dep: MergedDeparture) => void;
}

export function PlaceDeparturesView({
  place,
  onBack,
  modeFilter,
  onDepartureClick,
}: PlaceDeparturesViewProps) {
  const { t } = useTranslation();
  const { data: departures, isLoading: depsLoading } = useLinkedTransitDepartures(place);
  const { data: providers } = useProviders();
  const [tab, setTab] = useState<"departures" | "arrivals">("departures");
  const { data: arrivals, isLoading: arrivalsLoading } = useLinkedTransitArrivals(place);
  const { data: alerts } = useLinkedTransitAlerts(place);

  const alertRouteIds = useMemo(
    () =>
      new Set(
        (alerts ?? [])
          .filter((a) => a.severity === "severe" || a.severity === "critical")
          .flatMap((a) => a.affectedRouteIds),
      ),
    [alerts],
  );

  const items = tab === "departures" ? departures : arrivals;
  const isLoading = tab === "departures" ? depsLoading : arrivalsLoading;
  const filtered = modeFilter ? items?.filter((d) => d.route.mode === modeFilter) : items;
  const hasArrivals = arrivals && arrivals.length > 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <MaterialIcons name="arrow-back" size={20} color="#333" />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {place.name}
          </Text>
          <Text style={styles.headerSubtitle}>
            {modeFilter && MODE_LABEL_KEYS[modeFilter]
              ? `${t(`transit.${MODE_LABEL_KEYS[modeFilter]}`)} ${t(`transit.${tab}`)}`
              : t(`transit.${tab}`)}
          </Text>
        </View>
      </View>

      {/* Tab toggle */}
      {hasArrivals && (
        <View style={styles.tabRow}>
          <Pressable
            onPress={() => setTab("departures")}
            style={[styles.tabButton, tab === "departures" && styles.tabButtonActive]}
          >
            <Text style={[styles.tabText, tab === "departures" && styles.tabTextActive]}>
              {t("transit.departures")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab("arrivals")}
            style={[styles.tabButton, tab === "arrivals" && styles.tabButtonActive]}
          >
            <Text style={[styles.tabText, tab === "arrivals" && styles.tabTextActive]}>
              {t("transit.arrivals")}
            </Text>
          </Pressable>
        </View>
      )}

      {/* List */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          {[1, 2, 3, 4, 5].map((i) => (
            <View key={i} style={styles.skeleton}>
              <View style={styles.skeletonText} />
              <View style={styles.skeletonBadge} />
            </View>
          ))}
        </View>
      ) : filtered && filtered.length > 0 ? (
        <View>
          {filtered.map((dep) => (
            <View key={`${dep.tripId}-${dep.scheduledAt}`}>
              <DepartureRow
                departure={dep}
                showPlatform
                onPress={(dep) => onDepartureClick(dep as MergedDeparture)}
                hasAlert={alertRouteIds.has(dep.route.id)}
              />
              {dep.providers.length > 0 && (
                <Text style={styles.attribution}>
                  {dep.providers
                    .map((p) => {
                      const attr = resolveProvider(providers, p);
                      return attr.license ? `${attr.label} (${attr.license})` : attr.label;
                    })
                    .join(" · ")}
                </Text>
              )}
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>
            {modeFilter && MODE_LABEL_KEYS[modeFilter]
              ? t("transit.noDeparturesMode", {
                  mode: t(`transit.${MODE_LABEL_KEYS[modeFilter]}`),
                  tab: t(`transit.${tab}`),
                })
              : t("transit.noDeparturesGeneric", {
                  tab: t(`transit.${tab}`),
                })}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
    paddingTop: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  headerSubtitle: {
    fontSize: 12,
    color: "#888",
  },
  tabRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#e0e0e0",
  },
  tabButtonActive: {
    borderColor: TEAL,
    backgroundColor: `${TEAL}10`,
  },
  tabText: {
    fontSize: 13,
    color: "#888",
  },
  tabTextActive: {
    color: TEAL,
    fontWeight: "600",
  },
  loadingContainer: {
    padding: 12,
    gap: 8,
  },
  skeleton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  skeletonText: {
    flex: 1,
    height: 14,
    borderRadius: 2,
    backgroundColor: "#e0e0e0",
  },
  skeletonBadge: {
    width: 40,
    height: 14,
    borderRadius: 2,
    backgroundColor: "#e0e0e0",
  },
  emptyState: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
  },
  attribution: {
    fontSize: 10,
    color: "#999",
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
});
