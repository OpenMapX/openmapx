import type { TripItinerary } from "@openmapx/core";
import { useDirectionsStore } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Divider, Text } from "react-native-paper";
import { TransitDetailsView } from "./TransitDetailsView";
import { TransitItineraryCard } from "./TransitRouteView";

const TEAL = "#007b8b";

interface TransitPanelContentProps {
  itineraries: TripItinerary[];
  isLoading: boolean;
  isError: boolean;
  provider?: string;
}

export function TransitPanelContent({
  itineraries,
  isLoading,
  isError,
  provider,
}: TransitPanelContentProps) {
  const { t } = useTranslation();
  const { activeItineraryIndex, setActiveItineraryIndex, originLabel, destinationLabel } =
    useDirectionsStore();
  const [detailsIndex, setDetailsIndex] = useState<number | null>(null);

  if (detailsIndex !== null && itineraries[detailsIndex]) {
    return (
      <TransitDetailsView
        itinerary={itineraries[detailsIndex]}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        provider={provider}
        onBack={() => setDetailsIndex(null)}
      />
    );
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size={28} color={TEAL} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{t("directions.transitNotAvailable")}</Text>
      </View>
    );
  }

  if (itineraries.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>{t("directions.noRoutesFound")}</Text>
      </View>
    );
  }

  return (
    <View>
      {itineraries.map((itin, i) => (
        <View key={`itin-${itin.startTime}`}>
          <TransitItineraryCard
            itinerary={itin}
            active={i === activeItineraryIndex}
            onSelect={() => setActiveItineraryIndex(i)}
            onDetails={() => setDetailsIndex(i)}
          />
          {i < itineraries.length - 1 && <Divider />}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    paddingVertical: 32,
  },
  emptyText: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
  },
  errorText: {
    fontSize: 14,
    color: "#d32f2f",
    textAlign: "center",
  },
});
