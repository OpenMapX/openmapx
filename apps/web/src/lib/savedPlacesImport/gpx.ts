import { parseSavedPlaceContributors } from "@openmapx/core/saved-place-contributors";
import {
  SAVED_PLACE_XML_NAMESPACE,
  savedPlaceNoteFromDescription,
} from "@openmapx/core/saved-place-description";
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
    const extensions = elements(waypoint, "extensions");
    const omxText = (name: string) =>
      extensions
        .flatMap((extension) => elements(extension, name))
        .find((element) => element.namespaceURI === SAVED_PLACE_XML_NAMESPACE)
        ?.textContent?.trim();
    const fieldContributors = parseSavedPlaceContributors(omxText("fieldContributors"));
    const address =
      omxText("address") ||
      elements(waypoint, "extensions")
        .flatMap((extension) => elements(extension, "address"))
        .find(
          (element) =>
            element.namespaceURI === "https://osmand.net" ||
            element.namespaceURI?.startsWith("https://osmand.net/"),
        )
        ?.textContent?.trim();
    // Our namespace marks the description convention even when no source receipts were acquired.
    const ownExport =
      extensions.some((extension) =>
        Array.from(extension.getElementsByTagName("*")).some(
          (element) => element.namespaceURI === SAVED_PLACE_XML_NAMESPACE,
        ),
      ) ||
      Array.from(doc.documentElement.attributes).some(
        (attribute) =>
          attribute.namespaceURI === "http://www.w3.org/2000/xmlns/" &&
          attribute.value === SAVED_PLACE_XML_NAMESPACE,
      );
    const description =
      childText(waypoint, "desc", !ownExport) || childText(waypoint, "cmt", !ownExport);
    places.push(
      makePlace({
        name: childText(waypoint, "name") || options.droppedPin || "Dropped pin",
        lat,
        lng,
        status: "exact",
        address,
        fieldContributors,
        note: ownExport
          ? savedPlaceNoteFromDescription(description, { address, fieldContributors })
          : description,
      }),
    );
    groups.set(group, places);
  }
  if (groups.size <= 1) return [{ ...base, places: [...groups.values()].flat() }];
  return [...groups].map(([name, places]) => ({ ...base, name: name || base.name, places }));
}
