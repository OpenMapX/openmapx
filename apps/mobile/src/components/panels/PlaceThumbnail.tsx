import { MaterialIcons } from "@expo/vector-icons";
import { usePlaceDetails } from "@openmapx/core";
import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";

interface Props {
  lat: number;
  lng: number;
  name: string;
  placeId?: string | null;
  size?: number;
}

export function PlaceThumbnail({ lat, lng, name, placeId, size = 64 }: Props) {
  const { data: place } = usePlaceDetails(placeId ?? null, [lng, lat], name);
  const [failed, setFailed] = useState(false);

  const photo = place?.photos?.[0];
  const url = photo?.thumbnailUrl ?? photo?.url;
  const showImage = url && !failed;

  return (
    <View style={[styles.container, { width: size, height: size, borderRadius: size * 0.125 }]}>
      {showImage ? (
        <Image
          source={{ uri: url }}
          style={styles.image}
          onError={() => setFailed(true)}
          accessibilityLabel={name}
        />
      ) : (
        <MaterialIcons name="bookmark" size={28} color="#bdbdbd" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#eeeeee",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
});
