import { MaterialIcons } from "@expo/vector-icons";
import type { AlertSeverity, ServiceAlert } from "@openmapx/core";
import { resolveProvider, useProviders } from "@openmapx/core";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

const SEVERITY_CONFIG: Record<
  AlertSeverity,
  {
    icon: keyof typeof MaterialIcons.glyphMap;
    bg: string;
    border: string;
    color: string;
  }
> = {
  info: {
    icon: "info-outline",
    bg: "#E8F4FD",
    border: "#90CAF9",
    color: "#1565C0",
  },
  warning: {
    icon: "report-problem",
    bg: "#FFF8E1",
    border: "#FFE082",
    color: "#E65100",
  },
  severe: {
    icon: "error-outline",
    bg: "#FBE9E7",
    border: "#FFAB91",
    color: "#BF360C",
  },
  critical: {
    icon: "error-outline",
    bg: "#FFEBEE",
    border: "#EF9A9A",
    color: "#B71C1C",
  },
};

export const SEVERITY_PRIORITY: Record<AlertSeverity, number> = {
  critical: 4,
  severe: 3,
  warning: 2,
  info: 1,
};

interface AlertCardProps {
  alert: ServiceAlert;
  compact?: boolean;
  expandable?: boolean;
}

export function AlertCard({ alert, compact = false, expandable = true }: AlertCardProps) {
  const [descExpanded, setDescExpanded] = useState(false);
  const { data: providers } = useProviders();
  const config = SEVERITY_CONFIG[alert.severity];

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: config.bg,
          borderLeftColor: config.border,
          padding: compact ? 6 : 10,
          gap: compact ? 6 : 8,
        },
      ]}
    >
      <MaterialIcons
        name={config.icon}
        size={compact ? 16 : 18}
        color={config.color}
        style={styles.icon}
      />
      <View style={styles.content}>
        <Text
          style={[
            styles.title,
            {
              color: config.color,
              fontSize: compact ? 11 : 13,
            },
          ]}
        >
          {alert.title}
        </Text>
        {!compact && alert.description && (
          <Pressable onPress={expandable ? () => setDescExpanded((e) => !e) : undefined}>
            <Text
              style={styles.description}
              numberOfLines={descExpanded || !expandable ? undefined : 2}
            >
              {alert.description}
            </Text>
          </Pressable>
        )}
        {!compact && alert.providers.length > 0 && (
          <Text style={styles.attribution}>
            {alert.providers.map((p, i) => {
              const attr = resolveProvider(providers, p);
              const parts: string[] = [];
              if (i > 0) parts.push(" · ");
              parts.push(attr.label);
              if (attr.license) parts.push(` (${attr.license})`);
              return parts.join("");
            })}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderLeftWidth: 3,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
  },
  icon: {
    marginTop: 1,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontWeight: "600",
    lineHeight: 18,
  },
  description: {
    fontSize: 12,
    color: "#666",
    marginTop: 2,
    lineHeight: 17,
  },
  attribution: {
    fontSize: 10,
    color: "#999",
    marginTop: 4,
  },
});
