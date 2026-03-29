import { MaterialIcons } from "@expo/vector-icons";
import type { MergedDeparture, TripRemark } from "@openmapx/core";
import {
  MODE_COLORS,
  resolveProvider,
  useProviders,
  useRouteAlerts,
  useVehicleJourney,
} from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { AlertsBanner } from "./AlertsBanner";
import { RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";

const TEAL = "#007b8b";

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface TripDetailViewProps {
  departure: MergedDeparture;
  onBack: () => void;
}

export function TripDetailView({ departure, onBack }: TripDetailViewProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const {
    data: journey,
    isLoading,
    isError,
    refetch,
  } = useVehicleJourney(departure.tripId || null, departure.tripIds);
  const { data: alerts } = useRouteAlerts(departure.route.id);
  const { data: providers } = useProviders();

  const isDelayed = (departure.delaySeconds ?? 0) > 60;
  const isCanceled = departure.canceled === true;
  const lineColor = departure.route.color
    ? `#${departure.route.color.replace("#", "")}`
    : (MODE_COLORS[departure.route.mode] ?? TEAL);

  return (
    <View>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.outlineVariant }]}>
        <Pressable onPress={onBack} hitSlop={8}>
          <MaterialIcons name="arrow-back" size={20} color={theme.colors.onSurface} />
        </Pressable>
        <View style={styles.headerContent}>
          <View style={styles.headerTop}>
            <RouteBadge
              shortName={departure.route.shortName}
              color={departure.route.color}
              mode={departure.route.mode}
            />
            <Text style={[styles.headsign, { color: theme.colors.onSurface }]} numberOfLines={1}>
              {departure.headsign}
            </Text>
          </View>
          <View style={styles.headerTimes}>
            <Text
              style={[
                styles.scheduledTime,
                { color: theme.colors.onSurfaceVariant },
                (isCanceled || isDelayed) && styles.lineThrough,
                isCanceled && { color: theme.colors.onSurfaceDisabled },
              ]}
            >
              {formatTime(departure.scheduledAt)}
            </Text>
            {isDelayed && !isCanceled && departure.expectedAt && (
              <Text style={styles.delayTime}>{formatTime(departure.expectedAt)}</Text>
            )}
            {isCanceled && <Text style={styles.canceledText}>{t("transit.canceled")}</Text>}
            {departure.platform && (
              <Text style={[styles.platformText, { color: theme.colors.onSurfaceVariant }]}>
                · {t("transit.platform")} {departure.platform}
              </Text>
            )}
          </View>
        </View>
      </View>

      {/* Route alerts */}
      {alerts && alerts.length > 0 && (
        <View style={styles.alertsContainer}>
          <AlertsBanner alerts={alerts} />
        </View>
      )}

      {/* Trip remarks */}
      {departure.remarks && departure.remarks.length > 0 && (
        <View style={styles.remarksContainer}>
          {departure.remarks.map((remark: TripRemark, i) => (
            <RemarkChip key={`remark-${remark.text?.slice(0, 20) ?? i}`} remark={remark} />
          ))}
        </View>
      )}

      {/* Stop sequence */}
      <View style={styles.stopsSection}>
        <Text style={styles.sectionTitle}>{t("transit.stops")}</Text>
        {isLoading ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator size={20} color={TEAL} />
          </View>
        ) : isError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{t("transit.couldNotLoadStops")}</Text>
            <Pressable onPress={() => refetch()} style={styles.retryButton}>
              <MaterialIcons name="refresh" size={16} color={TEAL} />
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </Pressable>
          </View>
        ) : journey ? (
          <View style={styles.stopsTimeline}>
            {/* Vertical line */}
            <View style={[styles.absoluteLine, { backgroundColor: lineColor }]} />
            {journey.stops.map((stop) => {
              const time =
                stop.expectedDeparture ??
                stop.expectedArrival ??
                stop.scheduledDeparture ??
                stop.scheduledArrival;
              const timeStr = time ? formatTime(time) : "";
              const isRealtime = stop.delaySeconds !== undefined;
              const delaySec = stop.delaySeconds ?? 0;
              const delayMin = Math.round(delaySec / 60);
              const isCanceledStop = stop.canceled ?? false;
              const isDeparted = stop.departed ?? false;

              return (
                <View
                  key={`stop-${stop.stopId}`}
                  style={[styles.stopRow, { opacity: isDeparted ? 0.45 : 1 }]}
                >
                  {/* Stop dot */}
                  <View
                    style={[
                      styles.stopDot,
                      {
                        backgroundColor: isCanceledStop
                          ? "#f44336"
                          : isDeparted
                            ? "#9e9e9e"
                            : theme.colors.surface,
                        borderColor: isCanceledStop
                          ? "#f44336"
                          : isDeparted
                            ? "#9e9e9e"
                            : lineColor,
                      },
                    ]}
                  />
                  {/* Time + delay */}
                  <View style={styles.stopTimeCell}>
                    <Text style={[styles.stopTime, delayMin > 0 && styles.stopTimeDelayed]}>
                      {timeStr}
                    </Text>
                    {delayMin > 0 && !isCanceledStop && (
                      <Text style={styles.stopDelay}>+{delayMin} min</Text>
                    )}
                  </View>
                  {/* Name + platform */}
                  <Text
                    style={[styles.stopNameText, isCanceledStop && styles.lineThrough]}
                    numberOfLines={1}
                  >
                    {stop.name}
                  </Text>
                  {stop.platform && (
                    <Text style={styles.stopPlatform}>
                      {t("transit.platform")} {stop.platform}
                    </Text>
                  )}
                  {!isDeparted && !isCanceledStop && (
                    <View
                      style={[
                        styles.realtimeDot,
                        {
                          backgroundColor: isRealtime ? "#4caf50" : "#bdbdbd",
                        },
                      ]}
                    />
                  )}
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={styles.noStopsText}>
            {departure.tripId
              ? t("transit.stopDetailsLater")
              : t("transit.stopSequenceNotAvailable")}
          </Text>
        )}
      </View>

      {/* Attribution */}
      {departure.providers.length > 0 && (
        <View style={styles.attribution}>
          <Text style={styles.attributionText}>
            {t("common.data")}:{" "}
            {departure.providers
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
  },
  headerContent: {
    flex: 1,
    minWidth: 0,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  headsign: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  headerTimes: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    flexWrap: "wrap",
  },
  scheduledTime: {
    fontSize: 14,
  },
  lineThrough: {
    textDecorationLine: "line-through",
  },
  disabledText: {},
  delayTime: {
    fontSize: 14,
    fontWeight: "600",
    color: "#d32f2f",
  },
  canceledText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#d32f2f",
  },
  platformText: {
    fontSize: 14,
  },
  alertsContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  remarksContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 4,
  },
  stopsSection: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
  },
  loadingCenter: {
    alignItems: "center",
    paddingVertical: 16,
  },
  errorContainer: {
    alignItems: "center",
    paddingVertical: 16,
  },
  errorText: {
    fontSize: 14,
    marginBottom: 8,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: TEAL,
    borderRadius: 4,
  },
  retryText: {
    fontSize: 12,
    color: TEAL,
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
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2.5,
    zIndex: 1,
  },
  stopTimeCell: {
    width: 50,
    alignItems: "flex-end",
    flexShrink: 0,
  },
  stopTime: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  stopTimeDelayed: {
    color: "#d32f2f",
  },
  stopDelay: {
    fontSize: 10,
    fontWeight: "600",
    color: "#d32f2f",
  },
  stopNameText: {
    fontSize: 14,
    flex: 1,
  },
  stopPlatform: {
    fontSize: 11,
    flexShrink: 0,
  },
  realtimeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    flexShrink: 0,
  },
  noStopsText: {
    fontSize: 14,
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
