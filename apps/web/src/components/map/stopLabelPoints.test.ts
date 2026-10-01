// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type StopPoint, stopLabelFeatures, stopPlaceName } from "./stopLabelPoints";

let nextId = 1;
function stop(name: string, coordinates: [number, number], rank = 1, subclass = "bus_stop") {
  return {
    id: nextId++,
    name,
    poiClass: subclass === "tram_stop" ? "railway" : "bus",
    subclass,
    rank,
    coordinates,
  } satisfies StopPoint;
}

// About 70 m apart: two platforms of one stop.
const MEMHARD_A: [number, number] = [13.4116, 52.5237];
const MEMHARD_B: [number, number] = [13.4108, 52.5233];
const ALEXANDERPLATZ_STATION: [number, number] = [13.4115, 52.5219];

describe("stopPlaceName", () => {
  it("drops the mode prefix and the street after the slash", () => {
    expect(stopPlaceName("S+U Alexanderplatz/Memhardstraße")).toBe("alexanderplatz");
    expect(stopPlaceName("S+U Alexanderplatz Bhf/Dircksenstr.")).toBe("alexanderplatz");
    expect(stopPlaceName("U Rotes Rathaus")).toBe("rotes rathaus");
    expect(stopPlaceName("S Hackescher Markt")).toBe("hackescher markt");
    expect(stopPlaceName("U Alexanderplatz (Berlin)")).toBe("alexanderplatz");
    expect(stopPlaceName("Spandauer Straße/Marienkirche")).toBe("spandauer straße");
  });
});

describe("stopLabelFeatures", () => {
  it("names the platforms of one stop once, at its most prominent platform", () => {
    const features = stopLabelFeatures(
      [
        stop("S+U Alexanderplatz/Memhardstraße", MEMHARD_A, 5),
        stop("S+U Alexanderplatz/Memhardstraße", MEMHARD_B, 2, "tram_stop"),
      ],
      [],
    );
    expect(features).toHaveLength(1);
    expect(features[0]?.geometry.coordinates).toEqual(MEMHARD_B);
    expect(features[0]?.properties).toMatchObject({ subclass: "tram_stop", rank: 2 });
  });

  it("keeps two stops that share a name but stand far apart", () => {
    const features = stopLabelFeatures(
      [stop("Hauptstraße", [13.4, 52.52]), stop("Hauptstraße", [13.45, 52.52])],
      [],
    );
    expect(features).toHaveLength(2);
  });

  it("flags stops named after a nearby station so its label speaks for them", () => {
    const features = stopLabelFeatures(
      [
        stop("S+U Alexanderplatz/Memhardstraße", MEMHARD_A),
        stop("Memhardstraße", MEMHARD_B),
        stop("U Alexanderplatz", [13.43, 52.52]),
      ],
      [{ name: "Berlin Alexanderplatz", coordinates: ALEXANDERPLATZ_STATION }],
    );
    const nearStation = Object.fromEntries(
      features.map((feature) => [feature.properties.name, feature.properties.nearStation]),
    );
    expect(nearStation).toEqual({
      "S+U Alexanderplatz/Memhardstraße": true,
      Memhardstraße: false,
      // Same name, but well over a kilometre from the station.
      "U Alexanderplatz": false,
    });
  });

  it("carries the tile feature id so a click opens the same place as the icon", () => {
    const platform = stop("Jüdenstraße", MEMHARD_A);
    expect(stopLabelFeatures([platform], [])[0]?.id).toBe(platform.id);
  });
});
