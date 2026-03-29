import { useRouteAlerts } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { AlertCard, SEVERITY_PRIORITY } from "./AlertCard";

interface LegAlertsProps {
  routeId?: string;
}

export function LegAlerts({ routeId }: LegAlertsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { data: alerts } = useRouteAlerts(routeId ?? null);

  if (!routeId || !alerts || alerts.length === 0) return null;

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  );
  const hiddenCount = sorted.length - 1;

  return (
    <View style={styles.container}>
      <AlertCard alert={sorted[0]} compact />
      {hiddenCount > 0 && (
        <>
          <Pressable onPress={() => setExpanded((e) => !e)}>
            <Text style={styles.toggleText}>
              {expanded
                ? t("transit.showLess")
                : t("transit.showMoreAlerts", { count: hiddenCount })}
            </Text>
          </Pressable>
          {expanded && (
            <View style={styles.expandedAlerts}>
              {sorted.slice(1).map((a) => (
                <AlertCard key={a.id} alert={a} compact />
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 6,
    marginBottom: 2,
    gap: 4,
  },
  toggleText: {
    fontSize: 10,
    color: "#888",
    paddingLeft: 6,
  },
  expandedAlerts: {
    gap: 4,
  },
});
