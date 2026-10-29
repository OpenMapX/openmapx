import {
  type SavedPlaceFieldContributors,
  savedPlaceContributors,
} from "./saved-place-contributors";
import { buildAttributionPresentation, parseAttributionHtml } from "./utils/attribution-api";

export const SAVED_PLACE_XML_NAMESPACE = "https://openmapx.org/ns/saved-place/1";

interface DescribedSavedPlace {
  address?: string | null;
  note?: string | null;
  fieldContributors?: SavedPlaceFieldContributors;
}

/** Files retain full notices and links without needing the application's credit dialog. */
export function savedPlaceAttribution(place: DescribedSavedPlace) {
  return savedPlaceContributors(place.fieldContributors, [
    "name",
    ...(place.address ? ["address" as const] : []),
    "lat",
    "lng",
  ]).map((receipt) =>
    parseAttributionHtml(buildAttributionPresentation(receipt, "content").fullHtml),
  );
}

export function savedPlaceDescriptionSuffix(place: DescribedSavedPlace): string {
  const attribution = savedPlaceAttribution(place)
    .map(({ text, links }) =>
      [text, ...links.map((link) => `${link.label}: ${link.url}`)].join("\n"),
    )
    .join("\n");
  return [place.address, attribution]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

export function describeSavedPlace(place: DescribedSavedPlace): string | null {
  return (
    [place.note, savedPlaceDescriptionSuffix(place)]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n") || null
  );
}

/** Call only for marked OpenMapX files; an edited or unmatched suffix remains user text. */
export function savedPlaceNoteFromDescription(
  description: string,
  place: DescribedSavedPlace,
): string {
  const suffix = savedPlaceDescriptionSuffix(place);
  if (!suffix) return description;
  if (description === suffix) return "";
  return description.endsWith(`\n${suffix}`)
    ? description.slice(0, -suffix.length - 1)
    : description;
}
