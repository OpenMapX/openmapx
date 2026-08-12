import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const timeZoneAt = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    timeZoneAt: (...args: unknown[]) => timeZoneAt(...args),
    viewerTimeZone: () => "Europe/Berlin",
  };
});
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { PlaceLocalTime } from "./PlaceLocalTime";

describe("PlaceLocalTime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date("2026-07-15T10:00:00Z"));
  });

  it("renders the local clock and lead when the zone differs", () => {
    timeZoneAt.mockReturnValue("Asia/Tokyo");
    render(<PlaceLocalTime lat={35.68} lng={139.69} />);

    expect(screen.getByText("19:00")).toBeInTheDocument();
    expect(screen.getByText(/UTC\+9/)).toBeInTheDocument();
  });

  it("renders nothing when the zone matches the viewer", () => {
    timeZoneAt.mockReturnValue("Europe/Berlin");
    const { container } = render(<PlaceLocalTime lat={52.52} lng={13.405} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the lookup fails", () => {
    timeZoneAt.mockReturnValue(null);
    const { container } = render(<PlaceLocalTime lat={52.52} lng={13.405} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when two distinct zones share an offset", () => {
    timeZoneAt.mockReturnValue("Europe/Paris");
    const { container } = render(<PlaceLocalTime lat={48.85} lng={2.35} />);

    expect(container.firstChild).toBeNull();
  });
});
