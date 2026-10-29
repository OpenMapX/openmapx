import Papa from "papaparse";
import { coordinatesFromGoogleUrl, isGoogleMapsUrl, nameFromGoogleUrl } from "./googleUrl";
import {
  fileList,
  ImportFileError,
  type ImportList,
  makePlace,
  type ParseOptions,
  validCoordinates,
} from "./types";

const latitude = ["lat", "latitude", "y"];
const longitude = ["lon", "lng", "long", "longitude", "x"];
export function parseCsv(
  input: string,
  filename: string,
  options: ParseOptions = {},
  takeoutOnly = false,
): ImportList[] {
  const lines = input.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  let headerIndex = -1;
  let delimiter = "";
  for (let index = 0; index < lines.length && headerIndex < 0; index++) {
    for (const candidate of [",", ";", "\t", "|"]) {
      const row = Papa.parse<string[]>(lines[index], { delimiter: candidate }).data[0] || [];
      const headers = row.map((h) => h.trim().toLowerCase());
      if (
        (headers.includes("title") && headers.includes("url")) ||
        (!takeoutOnly &&
          headers.some((h) => latitude.includes(h)) &&
          headers.some((h) => longitude.includes(h)))
      ) {
        headerIndex = index;
        delimiter = candidate;
        break;
      }
    }
  }
  if (headerIndex < 0) throw new ImportFileError(input.trim() ? "unsupported" : "empty");
  const parsed = Papa.parse<string[]>(lines.slice(headerIndex).join("\n"), {
    delimiter,
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.some((e) => e.type === "Quotes")) throw new ImportFileError("malformed");
  const headers = parsed.data[0].map((h) => h.trim().toLowerCase());
  const takeout = headers.includes("url") && headers.includes("title");
  const places = parsed.data.slice(1).flatMap((row) => {
    if (row.every((value) => !value.trim())) return [];
    const field = (...names: string[]) =>
      row[headers.findIndex((h) => names.includes(h))]?.trim() || "";
    if (takeout && !isGoogleMapsUrl(field("url"))) return [];
    const coords = takeout
      ? coordinatesFromGoogleUrl(field("url"))
      : {
          lat: Number(field(...latitude)),
          lng: Number(field(...longitude)),
          status: "exact" as const,
        };
    if (
      !takeout &&
      (!field(...latitude) ||
        !field(...longitude) ||
        !validCoordinates(coords.lat as number, coords.lng as number))
    )
      return [];
    const name =
      field("name", "title") ||
      (takeout ? nameFromGoogleUrl(field("url")) : "") ||
      (coords.status !== "needsLookup" ? options.droppedPin || "Dropped pin" : "");
    if (!name) return [];
    const tags = field("tags")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const note = takeout
      ? [
          field("note"),
          field("comment"),
          tags.length ? `${options.tagsLabel || "Tags"}: ${tags.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : field("note", "description", "comment");
    return [makePlace({ name, ...coords, note, address: field("address") })];
  });
  return [fileList(filename, places, filename)];
}
