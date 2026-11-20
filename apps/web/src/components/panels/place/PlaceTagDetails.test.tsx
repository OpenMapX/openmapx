import { describe, expect, it, vi } from "vitest";
import { render } from "@/test";
import { PlaceTagDetails } from "./PlaceTagDetails";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

/** A café with most of the tags the details know, including some that are never shown. */
const CAFE: Record<string, string> = {
  operator: "Stadtwerke Aachen",
  "operator:wikidata": "Q1",
  brand: "Café Kram",
  network: "Kram Group",
  email: "info@example.com",
  access: "customers",
  wheelchair: "limited",
  fee: "yes",
  charge: "2 EUR",
  indoor: "yes",
  level: "1",
  locked: "no",
  surface: "paving_stones",
  ele: "173",
  height: "12",
  "building:levels": "3",
  capacity: "40",
  stars: "4",
  smoking: "outside",
  dog: "yes",
  drinking_water: "yes",
  toilets: "yes",
  "toilets:wheelchair": "yes",
  changing_table: "yes",
  shower: "no",
  drive_through: "no",
  delivery: "yes",
  takeaway: "only",
  outdoor_seating: "yes",
  internet_access: "wlan",
  manufacturer: "Siemens",
  model: "S1",
  cuisine: "coffee_shop;cake",
  religion: "christian",
  denomination: "catholic",
  start_date: "1898",
  heritage: "4",
  min_age: "18",
  "contact:facebook": "https://facebook.com/cafekram",
  "contact:instagram": "cafekram",
  "contact:mastodon": "@kram@social.example",
  description: "Small café",
};

const PRACTICAL = [
  "info@example.com <mailto:info@example.com>",
  "place.wheelchairLimited",
  "place.accessCustomers",
  "place.feeYes · 2 EUR",
  "Coffee shop, Cake",
  "place.smokingOutside",
  "place.dogYes",
  "place.delivery",
  "place.takeawayOnly",
  "place.outdoorSeating",
  "place.wifiAvailable",
  "place.drinkingWater",
  "place.toilets · place.toiletsWheelchairYes",
  "place.changingTable",
  "Facebook <https://facebook.com/cafekram>",
  "Instagram <https://www.instagram.com/cafekram>",
  "Mastodon <https://social.example/@kram>",
];

const REMAINING = [
  "Stadtwerke Aachen <https://www.wikidata.org/wiki/Q1>",
  "Café Kram (Kram Group)",
  "Christian · Catholic",
  "place.indoor",
  "place.level 1",
  "place.unlocked",
  "place.capacity 40",
  "★★★★",
  "173 m",
  "Paving stones",
  "12 m",
  "3 place.floors",
  "1898",
  "place.heritageYes",
  "place.minAge",
  "Siemens · S1",
  "Small café",
];

/** Each shown row as its text, and each link with where it leads. */
function rows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("p, a"), (element) => {
    const text = element.textContent?.trim() || element.getAttribute("aria-label") || "";
    return element.tagName === "A" ? `${text} <${element.getAttribute("href")}>` : text;
  });
}

const sorted = (values: string[]) => [...values].sort();

describe("PlaceTagDetails", () => {
  it("shows practical rows for what a visitor needs", () => {
    const { container } = render(<PlaceTagDetails osmTags={CAFE} section="practical" />);
    expect(rows(container)).toEqual(PRACTICAL);
  });

  it("shows the remaining rows for everything else it knows", () => {
    const { container } = render(<PlaceTagDetails osmTags={CAFE} section="remaining" />);
    expect(rows(container)).toEqual(REMAINING);
  });

  it("shows every row once when it is not split into sections", () => {
    const { container } = render(<PlaceTagDetails osmTags={CAFE} />);
    expect(sorted(rows(container))).toEqual(sorted([...PRACTICAL, ...REMAINING]));
  });

  it("leaves out an email the card already shows", () => {
    const { container } = render(
      <PlaceTagDetails osmTags={CAFE} section="practical" representedEmail=" INFO@example.com " />,
    );
    expect(rows(container)).toEqual(PRACTICAL.filter((row) => !row.startsWith("info@")));
  });

  it.each([
    ["practical", { operator: "Stadtwerke Aachen", start_date: "1898" }],
    ["remaining", { wheelchair: "yes", delivery: "yes" }],
    ["all", { shower: "no", drive_through: "no", name: "Café Kram" }],
  ] as const)("renders nothing for the %s section without a row to show", (section, tags) => {
    const { container } = render(<PlaceTagDetails osmTags={tags} section={section} />);
    expect(container.innerHTML).toBe("");
  });
});
