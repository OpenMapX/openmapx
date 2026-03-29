import { MaterialIcons } from "@expo/vector-icons";
import type { ServiceAlert } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { AlertCard, SEVERITY_PRIORITY } from "./AlertCard";

interface AlertsBannerProps {
  alerts: ServiceAlert[];
}

export function AlertsBanner({ alerts }: AlertsBannerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (alerts.length === 0) return null;

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  );
  const visibleAlerts = expanded ? sorted : sorted.slice(0, 2);
  const hasMore = sorted.length > 2;

  return (
    <View style={styles.container}>
      {visibleAlerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} />
      ))}
      {hasMore && (
        <Pressable onPress={() => setExpanded(!expanded)} style={styles.toggleRow}>
          <MaterialIcons name={expanded ? "expand-less" : "expand-more"} size={16} color="#888" />
          <Text style={styles.toggleText}>
            {expanded
              ? t("transit.showLess")
              : t("transit.moreAlerts", { count: sorted.length - 2 })}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 4,
  },
  toggleText: {
    fontSize: 12,
    color: "#888",
  },
});
