import { MaterialIcons } from "@expo/vector-icons";
import type { PlacePhoto } from "@openmapx/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

interface Props {
  photos: PlacePhoto[];
  placeName: string;
  onViewPhotos: () => void;
}

export function PlacePhotoHero({ photos, placeName, onViewPhotos }: Props) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  const photo = photos[0];
  if (!photo) return null;

  const isValid = photo.url.startsWith("https://") || photo.url.startsWith("http://");
  if (!isValid || failed) return null;

  const totalCount = photos.length;

  return (
    <Pressable onPress={onViewPhotos} style={styles.container}>
      <Image
        source={{ uri: photo.url }}
        style={styles.image}
        resizeMode="cover"
        accessibilityLabel={placeName}
        onError={() => setFailed(true)}
      />
      {/* Photo count badge */}
      {totalCount > 0 && (
        <View style={styles.badge}>
          <MaterialIcons name="collections" size={16} color="#fff" />
          <Text style={styles.badgeText}>{t("photoGallery.viewPhotos")}</Text>
        </View>
      )}
      {/* Attribution */}
      {photo.author && (
        <View style={styles.attribution}>
          <Text style={styles.attributionText} numberOfLines={1}>
            {photo.author}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 200,
    overflow: "hidden",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  badge: {
    position: "absolute",
    bottom: 10,
    left: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  badgeText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "500",
  },
  attribution: {
    position: "absolute",
    bottom: 4,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderRadius: 2,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  attributionText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 10,
  },
});
