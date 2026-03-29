import { MaterialIcons } from "@expo/vector-icons";
import type { Place } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Divider, Text, useTheme } from "react-native-paper";

interface Props {
  place: Place;
}

const STAR_ROWS = [5, 4, 3, 2, 1] as const;

function StarRow({ rating }: { rating: number }) {
  const rounded = Math.round(rating);
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <MaterialIcons key={n} name="star" size={18} color={n <= rounded ? "#FBBC04" : "#ccc"} />
      ))}
    </View>
  );
}

function RatingBar() {
  return (
    <View style={styles.ratingBar}>
      <View style={styles.ratingBarFill} />
    </View>
  );
}

export function PlaceReviewsTab({ place }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const links = place.reviewLinks ?? [];

  return (
    <View style={styles.container}>
      {/* Aggregate score */}
      {place.rating !== undefined && place.rating !== null && (
        <>
          <View style={styles.ratingSection}>
            <View style={styles.ratingBars}>
              {STAR_ROWS.map((n) => (
                <View key={n} style={styles.ratingBarRow}>
                  <Text style={styles.ratingBarLabel}>{n}</Text>
                  <RatingBar />
                </View>
              ))}
            </View>
            <View style={styles.ratingScore}>
              <Text style={styles.ratingNumber}>{place.rating.toFixed(1)}</Text>
              <StarRow rating={place.rating} />
              <Text style={[styles.reviewCount, { color: theme.colors.onSurfaceVariant }]}>
                {t("place.reviewsCount", { count: place.reviewCount ?? 0 })}
              </Text>
            </View>
          </View>
          <Divider style={styles.divider} />
        </>
      )}

      {/* External platform links */}
      {links.length > 0 && (
        <>
          <Text style={[styles.findReviewsLabel, { color: theme.colors.onSurfaceVariant }]}>
            {t("place.findReviewsOn")}
          </Text>
          {links.map(({ platform, url }) => (
            <Pressable
              key={platform}
              onPress={() => Linking.openURL(url)}
              style={({ pressed }) => [
                styles.linkRow,
                pressed && { backgroundColor: theme.colors.surfaceVariant },
              ]}
            >
              <Text style={styles.linkText}>{platform}</Text>
              <MaterialIcons name="open-in-new" size={16} color={theme.colors.onSurfaceDisabled} />
            </Pressable>
          ))}
          <Divider style={styles.divider} />
        </>
      )}

      {/* Open data note */}
      <Text style={[styles.openDataNote, { color: theme.colors.onSurfaceVariant }]}>
        {t("place.openDataNote")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
  },
  ratingSection: {
    flexDirection: "row",
    gap: 24,
    marginBottom: 16,
  },
  ratingBars: {
    flex: 1,
    gap: 4,
  },
  ratingBarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  ratingBarLabel: {
    width: 10,
    fontSize: 12,
    textAlign: "center",
  },
  ratingBar: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e0e0e0",
  },
  ratingBarFill: {
    height: "100%",
    borderRadius: 4,
    backgroundColor: "#FBBC04",
    width: "0%",
  },
  ratingScore: {
    alignItems: "center",
    flexShrink: 0,
  },
  ratingNumber: {
    fontSize: 40,
    fontWeight: "300",
    lineHeight: 44,
  },
  starRow: {
    flexDirection: "row",
    gap: 1,
    marginTop: 2,
  },
  reviewCount: {
    fontSize: 12,
    marginTop: 2,
  },
  divider: {
    marginBottom: 16,
  },
  findReviewsLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 0,
  },
  linkText: {
    flex: 1,
    fontSize: 14,
  },
  openDataNote: {
    fontSize: 12,
    textAlign: "center",
  },
});
