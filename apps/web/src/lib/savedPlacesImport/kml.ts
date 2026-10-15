import {
  fileList,
  ImportFileError,
  type ImportList,
  makePlace,
  type ParseOptions,
  validCoordinates,
} from "./types";
import { childText, elements, plainText, xml } from "./xml";

export function parseKml(
  input: string,
  filename: string,
  options: ParseOptions = {},
): ImportList[] {
  const doc = xml(input, "kml");
  const placemarks = elements(doc, "Placemark");
  if (!placemarks.length && elements(doc, "NetworkLink").length)
    throw new ImportFileError("networkLink");
  const documents = elements(doc, "Document");
  const roots = documents.filter((e) => !e.parentElement?.closest("Document"));
  return (roots.length ? roots : [doc.documentElement]).map((root) => {
    const places = elements(root, "Placemark").flatMap((mark) => {
      const point = elements(mark, "Point")[0];
      const coordinates =
        point && elements(point, "coordinates")[0]?.textContent?.trim().split(/\s+/)[0].split(",");
      if (!coordinates?.[0]?.trim() || !coordinates[1]?.trim()) return [];
      const [lng, lat] = coordinates.map(Number);
      if (!validCoordinates(lat, lng)) return [];
      const extended = elements(mark, "ExtendedData")[0];
      const mwm = (name: string) =>
        extended
          ? Array.from(extended.getElementsByTagName("*"))
              .find((e) => e.prefix === "mwm" && e.localName === name)
              ?.textContent?.trim() || ""
          : "";
      const address =
        childText(mark, "address") ||
        (extended
          ? [...elements(extended, "Data"), ...elements(extended, "SimpleData")]
              .find((e) => e.getAttribute("name")?.toLowerCase() === "address")
              ?.textContent?.trim()
          : "") ||
        "";
      return [
        makePlace({
          name: childText(mark, "name") || mwm("name") || options.droppedPin || "Dropped pin",
          lat,
          lng,
          status: "exact",
          address,
          note: plainText(childText(mark, "description") || mwm("description")),
        }),
      ];
    });
    const list = fileList(filename, places, filename);
    list.name = childText(root, "name") || list.name;
    return list;
  });
}
