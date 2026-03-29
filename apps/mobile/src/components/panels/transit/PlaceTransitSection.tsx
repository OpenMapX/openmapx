import { MaterialIcons } from "@expo/vector-icons";
import type { MergedDeparture, MergedRoute, Place, TransportMode } from "@openmapx/core";
import {
  useLinkedTransitAlerts,
  useLinkedTransitDepartures,
  useLinkedTransitFacilities,
  useLinkedTransitRoutes,
} from "@openmapx/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Divider, Text } from "react-native-paper";
import { AlertsBanner } from "./AlertsBanner";
import { DepartureRow } from "./DepartureRow";
import { FacilitiesSection } from "./FacilitiesSection";
import { RouteBadge } from "./RouteBadge";

const TEAL = "#007b8b";
const MAX_BADGES_PER_MODE = 8;

const MODE_ICONS: Partial<Record<TransportMode, keyof typeof MaterialIcons.glyphMap>> = {
  rail: "train",
  subway: "subway",
  tram: "tram",
  bus: "directions-bus",
  ferry: "directions-boat",
};

const MODE_LABEL_KEYS: Partial<Record<TransportMode, string>> = {
  rail: "trains",
  subway: "subway",
  tram: "trams",
  bus: "buses",
  ferry: "ferries",
};

function groupByMode(routes: MergedRoute[]): Map<TransportMode, MergedRoute[]> {
  const map = new Map<TransportMode, MergedRoute[]>();
  for (const route of routes) {
    const group = map.get(route.mode) ?? [];
    group.push(route);
    map.set(route.mode, group);
  }
  return map;
}

interface PlaceTransitSectionProps {
  place: Place;
  onOpenDepartures: (mode?: TransportMode) => void;
  onOpenLineDetail?: (route: MergedRoute) => void;
  onOpenTripDetail?: (dep: MergedDeparture) => void;
}

export function PlaceTransitSection({
  place,
  onOpenDepartures,
  onOpenLineDetail,
  onOpenTripDetail,
}: PlaceTransitSectionProps) {
  const { t } = useTranslation();
  const { data: routes, isLoading } = useLinkedTransitRoutes(place);
  const { data: alerts } = useLinkedTransitAlerts(place);
  const { data: departures, isLoading: depsLoading } = useLinkedTransitDepartures(place);
  const { data: facilities } = useLinkedTransitFacilities(place);

  const alertRouteIds = useMemo(
    () =>
      new Set(
        (alerts ?? [])
          .filter((a) => a.severity === "severe" || a.severity === "critical")
          .flatMap((a) => a.affectedRouteIds),
      ),
    [alerts],
  );

  if (isLoading && !routes) {
    return (
      <View style={styles.loadingContainer}>
        <Divider style={styles.divider} />
        <ActivityIndicator size={16} color="#999" />
      </View>
    );
  }

  if (!routes || routes.length === 0) return null;

  const grouped = groupByMode(routes);

  return (
    <View style={styles.container}>
      <Divider style={styles.divider} />

      {/* Section header */}
      <View style={styles.sectionHeader}>
        <MaterialIcons name="directions-transit" size={20} color={TEAL} />
        <Text style={styles.sectionTitle}>{t("transit.transit")}</Text>
      </View>

      {alerts && alerts.length > 0 && (
        <View style={styles.alertsBox}>
          <AlertsBanner alerts={alerts} />
        </View>
      )}

      {/* Routes grouped by mode */}
      {Array.from(grouped.entries()).map(([mode, modeRoutes]) => {
        const icon = MODE_ICONS[mode] ?? "directions-bus";
        const labelKey = MODE_LABEL_KEYS[mode];
        const label = labelKey ? t(`transit.${labelKey}`) : mode;
        return (
          <View key={mode} style={styles.modeGroup}>
            <Pressable onPress={() => onOpenDepartures(mode)} style={styles.modeHeader}>
              <MaterialIcons name={icon} size={16} color="#888" />
              <Text style={styles.modeLabel}>{label}</Text>
              <MaterialIcons name="chevron-right" size={14} color="#bbb" />
            </Pressable>
            <View style={styles.badgesRow}>
              {modeRoutes.slice(0, MAX_BADGES_PER_MODE).map((route) => (
                <RouteBadge
                  key={route.id}
                  shortName={route.shortName}
                  color={route.color}
                  textColor={route.textColor}
                  mode={route.mode}
                  onPress={onOpenLineDetail ? () => onOpenLineDetail(route) : undefined}
                />
              ))}
              {modeRoutes.length > MAX_BADGES_PER_MODE && (
                <Pressable onPress={() => onOpenDepartures(mode)}>
                  <Text style={styles.moreText}>
                    {t("transit.moreRoutes", {
                      count: modeRoutes.length - MAX_BADGES_PER_MODE,
                    })}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}

      {/* Departures preview */}
      <View style={styles.departuresHeader}>
        <MaterialIcons name="schedule" size={16} color="#888" />
        <Text style={styles.departuresLabel}>{t("transit.nextDepartures")}</Text>
      </View>
      {depsLoading && !departures && (
        <View style={styles.depsLoading}>
          <ActivityIndicator size={16} color="#999" />
        </View>
      )}
      {departures && departures.length > 0 ? (
        <View style={styles.departuresList}>
          {departures.slice(0, 5).map((dep) => (
            <DepartureRow
              key={`${dep.tripId}-${dep.scheduledAt}-${dep.route.id}`}
              departure={dep}
              onPress={
                onOpenTripDetail ? (dep) => onOpenTripDetail(dep as MergedDeparture) : undefined
              }
              hasAlert={alertRouteIds.has(dep.route.id)}
            />
          ))}
        </View>
      ) : !depsLoading && departures ? (
        <Text style={styles.noDeps}>{t("transit.noDeparturesInNext60")}</Text>
      ) : null}

      {/* Facilities */}
      {facilities && facilities.length > 0 && (
        <>
          <Divider style={styles.facilitiesDivider} />
          <FacilitiesSection facilities={facilities} />
        </>
      )}

      {/* Open departures button */}
      <Pressable onPress={() => onOpenDepartures()} style={styles.viewDeparturesButton}>
        <MaterialIcons name="schedule" size={16} color={TEAL} />
        <Text style={styles.viewDeparturesText}>{t("transit.viewDeparturesArrivals")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  loadingContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
  },
  divider: {
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  alertsBox: {
    marginBottom: 10,
  },
  modeGroup: {
    marginBottom: 10,
  },
  modeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
    paddingVertical: 2,
  },
  modeLabel: {
    fontSize: 12,
    color: "#888",
    fontWeight: "500",
    flex: 1,
  },
  badgesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    alignItems: "center",
  },
  moreText: {
    fontSize: 12,
    color: TEAL,
  },
  departuresHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    marginBottom: 4,
  },
  departuresLabel: {
    fontSize: 12,
    color: "#888",
    fontWeight: "500",
  },
  depsLoading: {
    paddingVertical: 8,
    alignItems: "center",
  },
  departuresList: {
    marginTop: 4,
    marginBottom: 4,
    marginHorizontal: -16,
  },
  noDeps: {
    fontSize: 12,
    color: "#888",
    marginTop: 4,
  },
  facilitiesDivider: {
    marginVertical: 8,
  },
  viewDeparturesButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: TEAL,
    borderRadius: 4,
    alignSelf: "flex-start",
  },
  viewDeparturesText: {
    fontSize: 13,
    color: TEAL,
    fontWeight: "500",
  },
});
