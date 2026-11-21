import { describe, expect, it } from "vitest";
import { getOverviewConsumedKeys } from "./PlaceTagDetails";

/**
 * Every simple tag key the place card shows somewhere: a detail row, the social
 * row, the Reviews tab, the gallery, or the linked identity metadata.
 */
const SHOWN_KEYS = [
  "operator",
  "brand",
  "network",
  "email",
  "contact:email",
  "access",
  "wheelchair",
  "fee",
  "charge",
  "indoor",
  "level",
  "locked",
  "surface",
  "ele",
  "height",
  "building:levels",
  "capacity",
  "stars",
  "smoking",
  "dog",
  "drinking_water",
  "toilets",
  "toilets:wheelchair",
  "changing_table",
  "shower",
  "drive_through",
  "delivery",
  "takeaway",
  "outdoor_seating",
  "internet_access",
  "manufacturer",
  "model",
  "cuisine",
  "religion",
  "denomination",
  "start_date",
  "heritage",
  "min_age",
  "operator:wikidata",
  "operator:wikipedia",
  "brand:wikidata",
  "brand:wikipedia",
  "contact:phone",
  "contact:website",
  "contact:tripadvisor",
  "contact:yelp",
  "ref:yelp",
  "image",
  "contact:facebook",
  "contact:instagram",
  "contact:twitter",
  "contact:youtube",
  "contact:linkedin",
  "contact:pinterest",
  "contact:telegram",
  "contact:whatsapp",
  "contact:reddit",
  "contact:tiktok",
  "contact:mastodon",
  "contact:bluesky",
  "contact:vk",
  "contact:threads",
  "contact:flickr",
  "contact:vimeo",
];

describe("getOverviewConsumedKeys", () => {
  it("keeps every tag a detail row, the social row or another card section shows out of other details", () => {
    expect(SHOWN_KEYS).toHaveLength(64);
    const shown = {
      ...Object.fromEntries(SHOWN_KEYS.map((key) => [key, "value"])),
      "image:2": "https://example.com/b.jpg",
      "description:de": "Klein",
      "addr:location": "Hinterhof",
    };
    const other = { name: "Café Kram", amenity: "cafe", opening_hours: "Mo-Fr 08:00-18:00" };
    expect([...getOverviewConsumedKeys({ ...shown, ...other })].sort()).toEqual(
      Object.keys(shown).sort(),
    );
  });
});
