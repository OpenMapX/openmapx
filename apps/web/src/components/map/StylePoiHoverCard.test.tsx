import type { Place } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";
import { StylePoiHoverCard, type StylePoiHoverCardProps } from "./StylePoiHoverCard";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

function details(overrides: Partial<Place> = {}): Place {
  return {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Nordsee",
    coordinates: [13.4, 52.52],
    category: "Fast Food",
    openingHours: "Mo-Su 09:30-20:30",
    openingHoursInfo: {
      status: { isOpen: true, isUnknown: false, text: "Mo-Su 09:30-20:30" },
      isAlwaysOpen: false,
      weekBitmap: "",
      validUntil: inAnHour(),
    },
    osmTags: { wheelchair: "yes" },
    ...overrides,
  } as Place;
}

function renderCard(props: Partial<StylePoiHoverCardProps> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onDirections: vi.fn(),
    onSave: vi.fn(),
    onPointerEnter: vi.fn(),
    onPointerLeave: vi.fn(),
  };
  render(
    <StylePoiHoverCard
      name="Nordsee"
      loading={false}
      placement={{ left: 10, top: 20, side: "below" }}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("StylePoiHoverCard", () => {
  it("shows the map's name at once and placeholder lines while the place loads", () => {
    renderCard({ loading: true });
    expect(screen.getByRole("region", { name: "Nordsee" })).toHaveTextContent("Nordsee");
    expect(screen.getByTestId("poi-hover-card-loading")).toBeInTheDocument();
  });

  it("shows category, wheelchair access and whether the place is open", () => {
    renderCard({ details: details() });
    expect(screen.queryByTestId("poi-hover-card-loading")).toBeNull();
    expect(screen.getByText("Fast Food")).toBeInTheDocument();
    expect(screen.getByTitle("place.wheelchairAccessible")).toBeInTheDocument();
    expect(screen.getByRole("region")).toHaveTextContent(/openingHours\.open|Open/i);
  });

  it("shows a rating with its review count and a photo when the place has them", () => {
    renderCard({
      details: details({
        rating: 4.4,
        reviewCount: 11338,
        photos: [{ url: "https://upload.wikimedia.org/x.jpg" }] as Place["photos"],
      }),
    });
    expect(screen.getByText("4.4")).toBeInTheDocument();
    expect(screen.getByText("(11,338)")).toBeInTheDocument();
    expect(document.querySelector("img")?.getAttribute("src")).toContain(
      encodeURIComponent("https://upload.wikimedia.org/x.jpg"),
    );
  });

  it("leaves out what the place lacks", () => {
    renderCard({ details: details({ osmTags: {}, openingHours: undefined, category: undefined }) });
    expect(screen.queryByTitle("place.wheelchairAccessible")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("region")).toHaveTextContent(/^Nordsee/);
  });

  it("opens the place from the card but lets each button do only its own job", () => {
    const handlers = renderCard({ details: details() });
    fireEvent.click(screen.getByRole("button", { name: "place.directions" }));
    fireEvent.click(screen.getByRole("button", { name: "place.savePlace" }));
    expect(handlers.onDirections).toHaveBeenCalledTimes(1);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    expect(handlers.onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("region"));
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it("reports the pointer entering and leaving, and shows a saved place as saved", () => {
    const handlers = renderCard({ saved: true });
    fireEvent.pointerEnter(screen.getByRole("region"));
    fireEvent.pointerLeave(screen.getByRole("region"));
    expect(handlers.onPointerEnter).toHaveBeenCalledTimes(1);
    expect(handlers.onPointerLeave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "place.savedPlace" })).toBeInTheDocument();
  });

  it("anchors by its bottom edge when it opens above the POI", () => {
    renderCard({ placement: { left: 10, bottom: 40, side: "above" } });
    const style = getComputedStyle(screen.getByRole("region"));
    expect(style.bottom).toBe("40px");
    expect(style.top).toBe("auto");
  });
});
