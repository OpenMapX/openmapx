import { Marker } from "@maplibre/maplibre-react-native";
import { usePlaceStore } from "@openmapx/core";
import { StyleSheet, View } from "react-native";

export function SelectedPlaceMarker() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);

  if (!selectedPlace?.coordinates) return null;

  const [lng, lat] = selectedPlace.coordinates;

  return (
    <Marker id="selected-place-marker" lngLat={[lng, lat]} anchor="bottom">
      <View style={styles.container}>
        {/* Pin head */}
        <View style={styles.head} />
        {/* Pin shaft */}
        <View style={styles.shaft} />
        {/* Pin point */}
        <View style={styles.point} />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    width: 30,
    height: 42,
  },
  head: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#e53935",
    borderWidth: 2.5,
    borderColor: "#b71c1c",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 5,
  },
  shaft: {
    width: 4,
    height: 10,
    backgroundColor: "#b71c1c",
    marginTop: -2,
  },
  point: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 6,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: "#b71c1c",
    marginTop: -1,
  },
});
