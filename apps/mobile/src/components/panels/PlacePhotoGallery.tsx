import { MaterialIcons } from "@expo/vector-icons";
import type { PlacePhoto } from "@openmapx/core";
import { usePlacePhotos } from "@openmapx/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { IconButton, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Props {
  visible: boolean;
  onClose: () => void;
  placeName: string;
  placeId: string;
  lat: number;
  lng: number;
}

function GalleryImage({
  photo,
  placeName,
  width,
  height,
}: {
  photo: PlacePhoto;
  placeName: string;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <View
        style={[
          { width, height, alignItems: "center", justifyContent: "center" },
          styles.failedContainer,
        ]}
      >
        <MaterialIcons name="broken-image" size={48} color="rgba(255,255,255,0.4)" />
        <Text style={styles.failedText}>Image could not be loaded</Text>
      </View>
    );
  }

  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      <Image
        source={{ uri: photo.url }}
        style={{ width, height: "100%" }}
        resizeMode="contain"
        accessibilityLabel={photo.author ?? placeName}
        onError={() => setFailed(true)}
      />
    </View>
  );
}

export function PlacePhotoGallery({ visible, onClose, placeName, placeId, lat, lng }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(0);

  // Reset index when gallery opens
  useEffect(() => {
    if (visible) setCurrentIndex(0);
  }, [visible]);

  const { data: allPhotos = [], isLoading } = usePlacePhotos(lat, lng, {
    name: placeName,
    placeId,
    limit: 30,
    enabled: visible,
  });

  const handleScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { x: number } } }) => {
      const idx = Math.round(event.nativeEvent.contentOffset.x / screenWidth);
      setCurrentIndex(idx);
    },
    [screenWidth],
  );

  const currentPhoto = allPhotos[currentIndex];

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.container}>
        {/* Top bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
          <IconButton
            icon={({ size }) => <MaterialIcons name="arrow-back" size={size} color="#fff" />}
            onPress={onClose}
            accessibilityLabel={t("common.back")}
          />
          <Text style={styles.title} numberOfLines={1}>
            {placeName}
          </Text>
          <View style={{ width: 48 }} />
        </View>

        {/* Main content */}
        {allPhotos.length === 0 && isLoading ? (
          <View style={styles.centerContent}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        ) : allPhotos.length === 0 ? (
          <View style={styles.centerContent}>
            <Text style={styles.emptyText}>{t("photoGallery.noPhotos")}</Text>
          </View>
        ) : (
          <FlatList
            data={allPhotos}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.url}
            renderItem={({ item }) => (
              <GalleryImage
                photo={item}
                placeName={placeName}
                width={screenWidth}
                height={screenHeight - 200}
              />
            )}
            onScroll={handleScroll}
            scrollEventThrottle={16}
          />
        )}

        {/* Bottom info bar */}
        {currentPhoto && (
          <View style={styles.bottomBar}>
            <View style={styles.bottomInfo}>
              {currentPhoto.author && (
                <Text style={styles.authorText} numberOfLines={1}>
                  {currentPhoto.author}
                </Text>
              )}
              {currentPhoto.source && (
                <Text style={styles.sourceText} numberOfLines={1}>
                  {currentPhoto.source}
                </Text>
              )}
            </View>
            <Text style={styles.counterText}>
              {currentIndex + 1} / {allPhotos.length}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 4,
  },
  title: {
    flex: 1,
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  centerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 16,
  },
  failedContainer: {
    gap: 8,
  },
  failedText: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 14,
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  bottomInfo: {
    flex: 1,
    marginRight: 12,
  },
  authorText: {
    color: "#fff",
    fontSize: 13,
  },
  sourceText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    marginTop: 2,
  },
  counterText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
  },
});
