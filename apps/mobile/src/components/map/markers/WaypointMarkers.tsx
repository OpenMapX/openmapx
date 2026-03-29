import { Marker } from "@maplibre/maplibre-react-native";
import { useDirectionsStore } from "@openmapx/core";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

const TEAL = "#007b8b";

export function WaypointMarkers() {
  const { isOpen, waypoints } = useDirectionsStore();

  if (!isOpen) return null;

  return (
    <>
      {waypoints.map((wp, i) => {
        if (!wp.coords) return null;

        const [lng, lat] = wp.coords;
        const isOrigin = i === 0;
        const isDestination = i === waypoints.length - 1;

        if (isDestination) return null; // Destination has its own marker

        return (
          <Marker key={wp.id} id={`waypoint-${wp.id}`} lngLat={[lng, lat]} anchor="center">
            {isOrigin ? (
              <View style={styles.originDot} />
            ) : (
              <View style={styles.waypointBadge}>
                <Text style={styles.waypointNumber}>{i}</Text>
              </View>
            )}
          </Marker>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  originDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: "#555",
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 3,
  },
  waypointBadge: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: TEAL,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 3,
  },
  waypointNumber: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
    lineHeight: 14,
  },
});
