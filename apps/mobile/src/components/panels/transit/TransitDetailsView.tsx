import { MaterialIcons } from "@expo/vector-icons";
import type { MergedDeparture, TripItinerary, TripLeg } from "@openmapx/core";
import { formatDuration, resolveProvider, useProviders } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Divider, Text, useTheme } from "react-native-paper";
import { LegAlerts } from "./LegAlerts";
import { RouteBadge } from "./RouteBadge";
import { TransitLegStops } from "./TransitLegStops";
import { LegBadge, LegRemarks, LiveStopTime, TransitLiveBadge } from "./TransitRouteView";
import { TripDetailView } from "./TripDetailView";

const TEAL = "#007b8b";
const WALK_COLOR = "#757575";

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function legToMergedDeparture(leg: TripLeg, provider?: string): MergedDeparture {
  return {
    tripId: leg.tripId ?? "",
    route: {
      id: leg.routeId ?? "",
      shortName: leg.route?.shortName ?? "",
      longName: leg.route?.longName ?? "",
      mode: leg.mode,
      color: leg.route?.color,
    },
    headsign: leg.to.name,
    scheduledAt: leg.startTime,
    providers: provider ? [provider] : [],
  };
}

const MODE_ICON_MAP: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  rail: "train",
  subway: "subway",
  tram: "tram",
  ferry: "directions-boat",
  bus: "directions-bus",
};

interface TransitDetailsViewProps {
  itinerary: TripItinerary;
  originLabel: string;
  destinationLabel: string;
  provider?: string;
  onBack: () => void;
}

export function TransitDetailsView({
  itinerary,
  originLabel,
  destinationLabel,
  provider,
  onBack,
}: TransitDetailsViewProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data: providers } = useProviders();
  const [activeLegDep, setActiveLegDep] = useState<MergedDeparture | null>(null);

  const startTime = formatTime(itinerary.startTime);
  const endTime = formatTime(itinerary.endTime);

  if (activeLegDep) {
    return <TripDetailView departure={activeLegDep} onBack={() => setActiveLegDep(null)} />;
  }

  return (
    <View>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <MaterialIcons name="arrow-back" size={20} color={theme.colors.onSurface} />
        </Pressable>
        <View style={styles.headerLabels}>
          <Text style={[styles.headerLabel, { color: theme.colors.onSurfaceVariant }]}>
            {t("directions.from")}{" "}
            <Text style={[styles.headerLabelBold, { color: theme.colors.onSurface }]}>
              {originLabel || t("directions.origin")}
            </Text>
          </Text>
          <Text style={[styles.headerLabel, { color: theme.colors.onSurfaceVariant }]}>
            {t("directions.to")}{" "}
            <Text style={[styles.headerLabelBold, { color: theme.colors.onSurface }]}>
              {destinationLabel || t("directions.destination")}
            </Text>
          </Text>
        </View>
      </View>
      <Divider />

      {/* Summary */}
      <View style={styles.summary}>
        <Text style={[styles.summaryTime, { color: theme.colors.onSurface }]}>
          {startTime} – {endTime}{" "}
        </Text>
        <Text style={[styles.summaryDuration, { color: theme.colors.onSurfaceVariant }]}>
          ({formatDuration(itinerary.duration)})
        </Text>
      </View>
      <View style={styles.legBadgeRow}>
        {itinerary.legs.map((leg, i) => (
          <View
            key={`badge-${leg.mode}-${leg.from.name}-${leg.to.name}`}
            style={styles.legBadgeItem}
          >
            {i > 0 && (
              <MaterialIcons
                name="chevron-right"
                size={14}
                color={theme.colors.onSurfaceDisabled}
              />
            )}
            <LegBadge leg={leg} />
          </View>
        ))}
      </View>
      <Divider />

      {/* Timeline */}
      <View style={styles.timeline}>
        {itinerary.legs.map((leg, i) => {
          const legStartTime = formatTime(leg.startTime);
          const legEndTime = formatTime(leg.endTime);
          const isWalk = leg.mode === "walking";
          const legColor = isWalk
            ? WALK_COLOR
            : leg.route?.color
              ? `#${leg.route.color.replace("#", "")}`
              : TEAL;
          const duration =
            (new Date(leg.endTime).getTime() - new Date(leg.startTime).getTime()) / 60000;

          return (
            <View key={`tl-${leg.from.name}-${leg.to.name}-${leg.mode}`}>
              {/* Departure point */}
              <View style={styles.timelineRow}>
                <View style={styles.timeCell}>
                  <LiveStopTime
                    scheduledTime={legStartTime}
                    tripId={
                      !isWalk
                        ? leg.tripId
                        : i > 0 && itinerary.legs[i - 1].tripId
                          ? itinerary.legs[i - 1].tripId
                          : undefined
                    }
                    stopId={leg.from.stopId}
                  />
                </View>
                <View
                  style={[
                    styles.dot,
                    {
                      borderColor: legColor,
                      backgroundColor: i === 0 ? legColor : theme.colors.surface,
                    },
                  ]}
                />
                <Text
                  style={[styles.stopName, { color: theme.colors.onSurface }]}
                  numberOfLines={1}
                >
                  {leg.from.name}
                </Text>
              </View>

              {/* Leg details */}
              <View style={styles.legDetailRow}>
                <View style={styles.timeCell} />
                <View style={styles.lineColumn}>
                  <View
                    style={[
                      styles.verticalLine,
                      { backgroundColor: isWalk ? "transparent" : legColor },
                      isWalk && {
                        borderLeftWidth: 3,
                        borderLeftColor: WALK_COLOR,
                        borderStyle: "dashed",
                      },
                    ]}
                  />
                </View>
                <View style={styles.legContent}>
                  {isWalk ? (
                    <View style={styles.walkRow}>
                      <MaterialIcons
                        name="directions-walk"
                        size={16}
                        color={theme.colors.onSurfaceVariant}
                      />
                      <Text style={[styles.walkText, { color: theme.colors.onSurfaceVariant }]}>
                        {t("directions.walkDuration", {
                          duration: formatDuration(Math.round(duration) * 60),
                        })}
                      </Text>
                    </View>
                  ) : (
                    <View>
                      <View style={styles.transitLegHeader}>
                        <MaterialIcons
                          name={MODE_ICON_MAP[leg.mode] ?? "directions-bus"}
                          size={16}
                          color={theme.colors.onSurfaceVariant}
                        />
                        <Pressable
                          onPress={
                            leg.tripId
                              ? () => setActiveLegDep(legToMergedDeparture(leg, provider))
                              : undefined
                          }
                          style={styles.routeInfo}
                        >
                          {leg.route && (
                            <RouteBadge
                              shortName={leg.route.shortName}
                              color={leg.route.color}
                              mode={leg.mode}
                              size="small"
                            />
                          )}
                          <Text
                            style={[styles.routeLongName, { color: theme.colors.onSurface }]}
                            numberOfLines={2}
                          >
                            {leg.route?.longName ?? leg.to.name}
                          </Text>
                        </Pressable>
                        {leg.tripId && <TransitLiveBadge tripId={leg.tripId} />}
                      </View>
                      <Text
                        style={[styles.transitDuration, { color: theme.colors.onSurfaceVariant }]}
                      >
                        {t("directions.transitDuration", {
                          duration: formatDuration(Math.round(duration) * 60),
                        })}
                      </Text>
                      <TransitLegStops
                        tripId={leg.tripId}
                        stopCount={leg._intermediateStopCount}
                        fromStopId={leg.from.stopId}
                        toStopId={leg.to.stopId}
                      />
                      <LegAlerts routeId={leg.routeId} />
                      {leg.tripId && <LegRemarks tripId={leg.tripId} />}
                    </View>
                  )}
                </View>
              </View>

              {/* Arrival point (last leg only) */}
              {i === itinerary.legs.length - 1 && (
                <View style={styles.timelineRow}>
                  <View style={styles.timeCell}>
                    <LiveStopTime
                      scheduledTime={legEndTime}
                      tripId={!isWalk ? leg.tripId : undefined}
                      stopId={leg.to.stopId}
                    />
                  </View>
                  <View
                    style={[
                      styles.dot,
                      {
                        borderColor: legColor,
                        backgroundColor: legColor,
                      },
                    ]}
                  />
                  <Text
                    style={[styles.stopName, { color: theme.colors.onSurface }]}
                    numberOfLines={1}
                  >
                    {leg.to.name}
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </View>

      {/* Attribution */}
      {provider &&
        (() => {
          const attr = resolveProvider(providers, provider);
          return (
            <View style={[styles.attribution, { borderTopColor: theme.colors.outlineVariant }]}>
              <Text style={[styles.attributionText, { color: theme.colors.onSurfaceVariant }]}>
                {t("common.data")}: {attr.label}
                {attr.license ? ` (${attr.license})` : ""}
              </Text>
            </View>
          );
        })()}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerLabels: {
    flex: 1,
  },
  headerLabel: {
    fontSize: 12,
  },
  headerLabelBold: {
    fontWeight: "600",
  },
  summary: {
    flexDirection: "row",
    alignItems: "baseline",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  summaryTime: {
    fontSize: 18,
    fontWeight: "600",
  },
  summaryDuration: {
    fontSize: 14,
  },
  legBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  legBadgeItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  timeline: {
    paddingLeft: 8,
    paddingRight: 16,
    paddingVertical: 8,
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
  },
  timeCell: {
    width: 50,
    alignItems: "flex-end",
    flexShrink: 0,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 3,
    flexShrink: 0,
  },
  stopName: {
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
  },
  legDetailRow: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 2,
  },
  lineColumn: {
    width: 12,
    alignItems: "center",
    flexShrink: 0,
  },
  verticalLine: {
    width: 3,
    flex: 1,
    minHeight: 32,
    borderRadius: 1,
  },
  legContent: {
    flex: 1,
    paddingVertical: 4,
    minWidth: 0,
  },
  walkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  walkText: {
    fontSize: 14,
  },
  transitLegHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexWrap: "wrap",
  },
  routeInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
  },
  routeLongName: {
    fontSize: 14,
    flexShrink: 1,
  },
  transitDuration: {
    fontSize: 12,
    marginTop: 2,
  },
  attribution: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attributionText: {
    fontSize: 10,
  },
});
