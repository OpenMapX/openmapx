import { Marker } from "@maplibre/maplibre-react-native";
import { useDirectionsStore } from "@openmapx/core";
import { StyleSheet, View } from "react-native";

export function DirectionsDestinationMarker() {
  const { isOpen, destination } = useDirectionsStore();

  if (!isOpen || !destination) return null;

  const [lng, lat] = destination;

  return (
    <Marker id="directions-destination-marker" lngLat={[lng, lat]} anchor="bottom">
      <View style={styles.container}>
        {/* Pin head */}
        <View style={styles.head}>
          <View style={styles.innerCircle} />
        </View>
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
    backgroundColor: "#EA4335",
    borderWidth: 1.5,
    borderColor: "#C5221F",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 5,
  },
  innerCircle: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#fff",
  },
  shaft: {
    width: 4,
    height: 10,
    backgroundColor: "#C5221F",
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
    borderTopColor: "#C5221F",
    marginTop: -1,
  },
});
