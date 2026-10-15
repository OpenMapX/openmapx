import { fileList, type ImportList, makePlace, type ParseOptions, validCoordinates } from "./types";
import { childText, elements, xml } from "./xml";

export function parseGpx(
  input: string,
  filename: string,
  options: ParseOptions = {},
): ImportList[] {
  const doc = xml(input, "gpx");
  const base = fileList(filename, [], filename);
  const metadata = elements(doc, "metadata")[0];
  if (metadata) base.name = childText(metadata, "name") || base.name;
  const groups = new Map<string, ImportList["places"]>();
  for (const waypoint of elements(doc, "wpt")) {
    const latText = waypoint.getAttribute("lat");
    const lngText = waypoint.getAttribute("lon");
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!latText || !lngText || !validCoordinates(lat, lng)) continue;
    const group = childText(waypoint, "type");
    const places = groups.get(group) || [];
    const address = elements(waypoint, "extensions")
      .flatMap((extension) => elements(extension, "address"))
      .find(
        (element) =>
          element.namespaceURI === "https://osmand.net" ||
          element.namespaceURI?.startsWith("https://osmand.net/"),
      )
      ?.textContent?.trim();
    places.push(
      makePlace({
        name: childText(waypoint, "name") || options.droppedPin || "Dropped pin",
        lat,
        lng,
        status: "exact",
        address,
        note: childText(waypoint, "desc") || childText(waypoint, "cmt"),
      }),
    );
    groups.set(group, places);
  }
  if (groups.size <= 1) return [{ ...base, places: [...groups.values()].flat() }];
  return [...groups].map(([name, places]) => ({ ...base, name: name || base.name, places }));
}
