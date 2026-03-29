import { MaterialIcons } from "@expo/vector-icons";
import type { Route } from "@openmapx/core";
import { formatDistance, formatDuration } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Divider, IconButton, Text, useTheme } from "react-native-paper";
import { ElevationProfile } from "@/components/ui/ElevationProfile";

const _TEAL = "#007b8b";

interface DetailsViewProps {
  route: Route;
  originLabel: string;
  destinationLabel: string;
  waypointLabels?: string[];
  units: "metric" | "imperial";
  onBack: () => void;
}

function StepRow({
  instruction,
  distance,
  duration,
  units,
}: {
  instruction: string;
  distance: number;
  duration: number;
  units: "metric" | "imperial";
}) {
  const theme = useTheme();
  const dist =
    units === "imperial" ? `${(distance / 1609.34).toFixed(1)} mi` : formatDistance(distance);

  return (
    <View>
      <View style={styles.stepRow}>
        <MaterialIcons
          name="chevron-right"
          size={18}
          color={theme.colors.onSurfaceVariant}
          style={styles.stepIcon}
        />
        <View style={styles.stepContent}>
          <Text style={[styles.stepInstruction, { color: theme.colors.onSurface }]}>
            {instruction}
          </Text>
        </View>
      </View>
      <View style={styles.stepMeta}>
        <Text style={[styles.stepMetaText, { color: theme.colors.onSurfaceVariant }]}>
          {formatDuration(duration)} ({dist})
        </Text>
        <Divider style={styles.stepDivider} />
      </View>
    </View>
  );
}

function LegHeader({
  fromLabel,
  toLabel,
  duration,
  distance,
  units,
  expanded,
  onToggle,
}: {
  fromLabel: string;
  toLabel: string;
  duration: number;
  distance: number;
  units: "metric" | "imperial";
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  const legDist =
    units === "imperial" ? `${(distance / 1609.34).toFixed(1)} mi` : formatDistance(distance);

  return (
    <Pressable
      onPress={onToggle}
      style={[
        styles.legHeader,
        {
          backgroundColor: theme.colors.surfaceVariant,
          borderTopColor: theme.colors.outlineVariant,
        },
      ]}
    >
      <MaterialIcons
        name={expanded ? "expand-more" : "chevron-right"}
        size={20}
        color={theme.colors.onSurfaceVariant}
      />
      <View style={styles.legHeaderContent}>
        <Text style={[styles.legTitle, { color: theme.colors.onSurface }]} numberOfLines={1}>
          {fromLabel} → {toLabel}
        </Text>
        <Text style={[styles.legSubtitle, { color: theme.colors.onSurfaceVariant }]}>
          {formatDuration(duration)} · {legDist}
        </Text>
      </View>
    </Pressable>
  );
}

export function DetailsView({
  route,
  originLabel,
  destinationLabel,
  waypointLabels,
  units,
  onBack,
}: DetailsViewProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const hasLegs = route.legs && route.legs.length > 1;
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  const intermediateLabels = waypointLabels ? waypointLabels.slice(1, -1).filter(Boolean) : [];
  const viaStr =
    intermediateLabels.length > 0
      ? t("directions.via", { stops: intermediateLabels.join(", ") })
      : undefined;

  const [expandedLegs, setExpandedLegs] = useState<Set<number>>(
    () => new Set(route.legs.map((_, i) => i)),
  );

  const toggleLeg = (index: number) => {
    setExpandedLegs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <IconButton
          icon={({ size }) => (
            <MaterialIcons name="arrow-back" size={size} color={theme.colors.onSurface} />
          )}
          size={20}
          onPress={onBack}
          style={styles.backButton}
        />
        <View>
          <Text style={[styles.headerLabel, { color: theme.colors.onSurfaceVariant }]}>
            {t("directions.from")}{" "}
            <Text style={[styles.headerBold, { color: theme.colors.onSurface }]}>
              {originLabel || t("directions.origin")}
            </Text>
          </Text>
          <Text style={[styles.headerLabel, { color: theme.colors.onSurfaceVariant }]}>
            {t("directions.to")}{" "}
            <Text style={[styles.headerBold, { color: theme.colors.onSurface }]}>
              {destinationLabel || t("directions.destination")}
            </Text>
          </Text>
          {viaStr && (
            <Text style={[styles.headerLabel, { color: theme.colors.onSurfaceVariant }]}>
              {viaStr}
            </Text>
          )}
        </View>
      </View>

      <Divider />

      {/* Summary */}
      <View style={styles.summary}>
        <Text style={styles.summaryDuration}>{formatDuration(route.duration)} </Text>
        <Text style={[styles.summaryDistance, { color: theme.colors.onSurfaceVariant }]}>
          ({dist})
        </Text>
        {route.summary && (
          <Text style={[styles.summaryVia, { color: theme.colors.onSurfaceVariant }]}>
            {route.summary}
          </Text>
        )}
      </View>

      <Divider />

      {/* Steps */}
      {hasLegs ? (
        route.legs.map((leg, i) => {
          const fromLabel =
            (waypointLabels ?? [originLabel, destinationLabel])[i] || t("directions.origin");
          const toLabel =
            (waypointLabels ?? [originLabel, destinationLabel])[i + 1] ||
            t("directions.destination");
          const isExpanded = expandedLegs.has(i);

          return (
            <View key={`leg-${leg.duration}-${leg.distance}`}>
              <LegHeader
                fromLabel={fromLabel}
                toLabel={toLabel}
                duration={leg.duration}
                distance={leg.distance}
                units={units}
                expanded={isExpanded}
                onToggle={() => toggleLeg(i)}
              />
              {isExpanded && (
                <>
                  <View style={styles.waypointLabel}>
                    <Text style={[styles.waypointLabelText, { color: theme.colors.onSurface }]}>
                      {fromLabel}
                    </Text>
                  </View>
                  {leg.steps.map((step) => (
                    <StepRow
                      key={`step-${leg.duration}-${step.instruction.slice(0, 30)}-${step.distance}`}
                      instruction={step.instruction}
                      distance={step.distance}
                      duration={step.duration}
                      units={units}
                    />
                  ))}
                  <View style={styles.waypointLabel}>
                    <Text style={[styles.waypointLabelText, { color: theme.colors.onSurface }]}>
                      {toLabel}
                    </Text>
                  </View>
                </>
              )}
            </View>
          );
        })
      ) : (
        <>
          <View style={styles.waypointLabel}>
            <Text style={[styles.waypointLabelText, { color: theme.colors.onSurface }]}>
              {originLabel || t("directions.origin")}
            </Text>
          </View>
          {route.steps.map((step) => (
            <StepRow
              key={`step-${step.instruction.slice(0, 30)}-${step.distance}`}
              instruction={step.instruction}
              distance={step.distance}
              duration={step.duration}
              units={units}
            />
          ))}
          <View style={styles.waypointLabel}>
            <Text style={[styles.waypointLabelText, { color: theme.colors.onSurface }]}>
              {destinationLabel || t("directions.destination")}
            </Text>
          </View>
        </>
      )}

      {/* Elevation profile */}
      {route.mode !== "transit" && <ElevationProfile route={route} units={units} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 8,
  },
  backButton: {
    margin: 0,
  },
  headerLabel: {
    fontSize: 12,
  },
  headerBold: {
    fontWeight: "600",
  },
  summary: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  summaryDuration: {
    fontSize: 18,
    fontWeight: "600",
    color: "#2E7D32",
  },
  summaryDistance: {
    fontSize: 16,
  },
  summaryVia: {
    fontSize: 14,
    marginTop: 2,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  stepIcon: {
    marginTop: 2,
  },
  stepContent: {
    flex: 1,
  },
  stepInstruction: {
    fontSize: 14,
  },
  stepMeta: {
    paddingLeft: 46,
    paddingRight: 16,
    paddingBottom: 4,
  },
  stepMetaText: {
    fontSize: 12,
  },
  stepDivider: {
    marginTop: 4,
  },
  legHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  legHeaderContent: {
    flex: 1,
  },
  legTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  legSubtitle: {
    fontSize: 12,
  },
  waypointLabel: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  waypointLabelText: {
    fontSize: 14,
    fontWeight: "700",
  },
});
