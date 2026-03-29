import { MaterialIcons } from "@expo/vector-icons";
import type { MergedDeparture, MergedRoute, Place, TransportMode } from "@openmapx/core";
import { usePlaceStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, Text, useTheme } from "react-native-paper";
import { PlaceInfoTab } from "./PlaceInfoTab";
import { PlaceOverviewTab } from "./PlaceOverviewTab";
import { PlacePhotoGallery } from "./PlacePhotoGallery";
import { PlacePhotoHero } from "./PlacePhotoHero";
import { PlaceReviewsTab } from "./PlaceReviewsTab";
import { PlaceDeparturesView } from "./transit/PlaceDeparturesView";
import { PlaceTransitSection } from "./transit/PlaceTransitSection";

const TEAL = "#007b8b";

interface Props {
  place: Place;
  isLoading: boolean;
}

const TAB_KEYS = ["overview", "reviews", "info"] as const;

export function PlaceDetailContent({ place, isLoading }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const setActiveRouteId = usePlaceStore((s) => s.setActiveRouteId);
  const setActiveTripDep = usePlaceStore((s) => s.setActiveTripDep);
  const [tab, setTab] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [departuresMode, setDeparturesMode] = useState<TransportMode | null>(null);
  const [showDepartures, setShowDepartures] = useState(false);

  const isTransitStop = place.id.startsWith("stop:");

  // Reset tab when a different place loads
  const placeId = place.id;
  useEffect(() => {
    void placeId;
    setTab(0);
    setGalleryOpen(false);
    setShowDepartures(false);
    setDeparturesMode(null);
  }, [placeId]);

  const enrichmentPhotos = place.photos ?? [];
  const hasPhoto =
    enrichmentPhotos.length > 0 &&
    (enrichmentPhotos[0].url.startsWith("https://") ||
      enrichmentPhotos[0].url.startsWith("http://"));

  return (
    <View testID="place-detail-content">
      {/* Hero photo */}
      {hasPhoto && (
        <PlacePhotoHero
          photos={enrichmentPhotos}
          placeName={place.name}
          onViewPhotos={() => setGalleryOpen(true)}
        />
      )}

      {/* Photo gallery modal */}
      <PlacePhotoGallery
        visible={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        placeName={place.name}
        placeId={place.id}
        lat={place.coordinates[1]}
        lng={place.coordinates[0]}
      />

      {/* Name / rating / category */}
      <View style={styles.header}>
        <Text variant="titleLarge" style={styles.placeName}>
          {place.name}
        </Text>
        {place.rating !== undefined && place.rating !== null && (
          <View style={styles.ratingRow}>
            <Text style={styles.ratingText}>{place.rating.toFixed(1)}</Text>
            <MaterialIcons name="star" size={16} color="#FBBC04" />
            {place.reviewCount !== undefined && (
              <Text style={[styles.reviewCountText, { color: theme.colors.onSurfaceVariant }]}>
                ({place.reviewCount.toLocaleString()})
              </Text>
            )}
          </View>
        )}
        {place.category && (
          <Chip
            compact
            mode="outlined"
            style={styles.categoryChip}
            textStyle={styles.categoryChipText}
          >
            {place.category}
          </Chip>
        )}
      </View>

      {/* Tab navigation */}
      <View style={[styles.tabBar, { borderBottomColor: theme.colors.outlineVariant }]}>
        {TAB_KEYS.map((key, idx) => (
          <Pressable key={key} onPress={() => setTab(idx)} style={styles.tab}>
            <Text
              style={[
                styles.tabLabel,
                tab === idx
                  ? { color: TEAL, fontWeight: "600" }
                  : { color: theme.colors.onSurfaceVariant },
              ]}
            >
              {t(`place.${key}`)}
            </Text>
            {tab === idx && <View style={styles.tabIndicator} />}
          </Pressable>
        ))}
      </View>

      {/* Departure board (overlay when opened from transit section) */}
      {showDepartures ? (
        <PlaceDeparturesView
          place={place}
          onBack={() => setShowDepartures(false)}
          modeFilter={departuresMode}
          onDepartureClick={(dep: MergedDeparture) => {
            setActiveTripDep(dep);
            router.push(`/transit/trip/${encodeURIComponent(dep.tripId)}`);
          }}
        />
      ) : (
        <>
          {/* Active tab content */}
          {tab === 0 && (
            <PlaceOverviewTab
              place={place}
              isLoading={isLoading}
              onNavigateToInfo={() => setTab(2)}
            />
          )}
          {tab === 1 && <PlaceReviewsTab place={place} />}
          {tab === 2 && <PlaceInfoTab place={place} isLoading={isLoading} />}

          {/* Transit section for transit stops */}
          {isTransitStop && tab === 0 && (
            <PlaceTransitSection
              place={place}
              onOpenDepartures={(mode?: TransportMode) => {
                setDeparturesMode(mode ?? null);
                setShowDepartures(true);
              }}
              onOpenLineDetail={(route: MergedRoute) => {
                setActiveRouteId(route.id);
                router.push(`/transit/route/${encodeURIComponent(route.id)}`);
              }}
              onOpenTripDetail={(dep: MergedDeparture) => {
                setActiveTripDep(dep);
                router.push(`/transit/trip/${encodeURIComponent(dep.tripId)}`);
              }}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  placeName: {
    fontWeight: "600",
    marginBottom: 4,
  },
  ratingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  ratingText: {
    fontSize: 14,
    fontWeight: "600",
  },
  reviewCountText: {
    fontSize: 14,
  },
  categoryChip: {
    alignSelf: "flex-start",
    borderRadius: 4,
    height: 28,
  },
  categoryChipText: {
    fontSize: 12,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    position: "relative",
  },
  tabLabel: {
    fontSize: 14,
  },
  tabIndicator: {
    position: "absolute",
    bottom: 0,
    left: 16,
    right: 16,
    height: 3,
    backgroundColor: TEAL,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
});
