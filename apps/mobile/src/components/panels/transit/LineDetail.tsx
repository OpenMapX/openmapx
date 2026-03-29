import { MaterialIcons } from "@expo/vector-icons";
import type { MergedRoute, Place, TransitStop } from "@openmapx/core";
import {
  MODE_COLORS,
  resolveProvider,
  useLinkedTransitStops,
  useProviders,
  useRouteAlerts,
  useRouteStops,
  useTransitRoute,
} from "@openmapx/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { AlertsBanner } from "./AlertsBanner";
import { RouteBadge } from "./RouteBadge";

const TEAL = "#007b8b";

interface LineDetailProps {
  routeId: string;
  routeHint?: MergedRoute;
  place?: Place;
  currentStop?: TransitStop;
  onBack: () => void;
  onSelectStop?: (stop: TransitStop) => void;
}

export function LineDetail({
  routeId,
  routeHint,
  place,
  currentStop,
  onBack,
  onSelectStop,
}: LineDetailProps) {
  const { t } = useTranslation();
  const { data: routeData, isLoading: routeLoading } = useTransitRoute(routeId);
  const route: (typeof routeData & { providers?: string[] }) | null =
    routeData ?? routeHint ?? null;
  const providersList = routeHint?.providers ?? (route as MergedRoute)?.providers ?? [];

  const { data: linkedStops } = useLinkedTransitStops(place ?? null);
  const hintStopId = useMemo(() => {
    if (!linkedStops?.length) return undefined;
    const provider = providersList[0];
    if (provider) {
      const match = linkedStops.find((s) => s.provider === provider);
      if (match) return match.id;
    }
    return linkedStops[0].id;
  }, [linkedStops, providersList]);

  const { data: stops, isLoading: stopsLoading } = useRouteStops(routeId, hintStopId);
  const { data: alerts } = useRouteAlerts(routeId);
  const { data: providers } = useProviders();

  const lineColor = route?.color
    ? `#${route.color.replace("#", "")}`
    : route?.mode
      ? MODE_COLORS[route.mode]
      : TEAL;

  return (
    <View>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <MaterialIcons name="arrow-back" size={20} color="#333" />
        </Pressable>
        {routeLoading && !routeHint ? (
          <ActivityIndicator size={16} color="#999" />
        ) : route ? (
          <View style={styles.headerRoute}>
            <RouteBadge
              shortName={route.shortName}
              color={route.color}
              textColor={route.textColor}
              mode={route.mode}
              size="medium"
            />
            <Text style={styles.routeLongName} numberOfLines={1}>
              {route.longName}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Operator */}
      {route?.operatorName && <Text style={styles.operator}>{route.operatorName}</Text>}

      {/* Alerts */}
      {alerts && alerts.length > 0 && (
        <View style={styles.alertsContainer}>
          <AlertsBanner alerts={alerts} />
        </View>
      )}

      {/* Stop sequence */}
      <View style={styles.stopsSection}>
        <Text style={styles.sectionTitle}>{t("transit.stops")}</Text>
        {stopsLoading ? (
          <View style={styles.loadingContainer}>
            {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5", "sk-6"].map((skKey) => (
              <View key={skKey} style={styles.skeletonRow}>
                <View style={styles.skeletonDot} />
                <View style={styles.skeletonText} />
              </View>
            ))}
          </View>
        ) : stops && stops.length > 0 ? (
          <View style={styles.stopsTimeline}>
            <View style={[styles.absoluteLine, { backgroundColor: lineColor }]} />
            {stops.map((s) => {
              const isCurrent = currentStop ? s.id === currentStop.id : false;
              return (
                <Pressable
                  key={`${s.id}-${s.name}`}
                  onPress={() => {
                    if (!onSelectStop || !currentStop) return;
                    onSelectStop({
                      id: s.id,
                      name: s.name,
                      lat: s.lat,
                      lng: s.lng,
                      modes: route?.mode ? [route.mode] : currentStop.modes,
                      provider: providersList[0] ?? currentStop.provider,
                    });
                  }}
                  style={styles.stopRow}
                >
                  <View
                    style={[
                      styles.stopDot,
                      {
                        width: isCurrent ? 14 : 10,
                        height: isCurrent ? 14 : 10,
                        borderRadius: isCurrent ? 7 : 5,
                        backgroundColor: isCurrent ? lineColor : "#fff",
                        borderColor: lineColor,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.stopName,
                      {
                        fontWeight: isCurrent ? "700" : "400",
                        color: isCurrent ? "#333" : "#888",
                      },
                    ]}
                  >
                    {s.name}
                  </Text>
                  {s.platformCode && (
                    <Text style={styles.stopPlatform}>
                      {t("transit.platform")} {s.platformCode}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={styles.noDataText}>{t("transit.stopDataNotAvailable")}</Text>
        )}
      </View>

      {/* Attribution */}
      {route && providersList.length > 0 && (
        <View style={styles.attribution}>
          <Text style={styles.attributionText}>
            {t("common.data")}:{" "}
            {providersList
              .map((p) => {
                const attr = resolveProvider(providers, p);
                return attr.license ? `${attr.label} (${attr.license})` : attr.label;
              })
              .join(" · ")}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  headerRoute: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  routeLongName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
    flex: 1,
  },
  operator: {
    fontSize: 12,
    color: "#888",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  alertsContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  stopsSection: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
    marginBottom: 8,
  },
  loadingContainer: {
    gap: 8,
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  skeletonDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#e0e0e0",
  },
  skeletonText: {
    width: "60%",
    height: 14,
    borderRadius: 2,
    backgroundColor: "#e0e0e0",
  },
  stopsTimeline: {
    position: "relative",
    paddingLeft: 20,
  },
  absoluteLine: {
    position: "absolute",
    left: 5,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 1,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    position: "relative",
  },
  stopDot: {
    position: "absolute",
    left: -18,
    borderWidth: 3,
    zIndex: 1,
  },
  stopName: {
    fontSize: 14,
    flex: 1,
  },
  stopPlatform: {
    fontSize: 11,
    color: "#999",
    flexShrink: 0,
  },
  noDataText: {
    fontSize: 14,
    color: "#888",
  },
  attribution: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0e0",
  },
  attributionText: {
    fontSize: 10,
    color: "#999",
  },
});
