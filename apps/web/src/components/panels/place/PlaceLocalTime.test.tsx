import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const timeZoneAt = vi.fn();
const tzDiffMinutes = vi.fn();
const tzOffsetLabel = vi.fn();
const time = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    timeZoneAt: (...args: unknown[]) => timeZoneAt(...args),
    viewerTimeZone: () => "Europe/Berlin",
    tzDiffMinutes: (...args: unknown[]) => tzDiffMinutes(...args),
    tzOffsetLabel: (...args: unknown[]) => tzOffsetLabel(...args),
  };
});
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (...args: unknown[]) => time(...args) }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { PlaceLocalTime } from "./PlaceLocalTime";

describe("PlaceLocalTime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date("2026-07-15T10:00:00Z"));
    // Default every helper to the real Tokyo-vs-Berlin values for the frozen
    // instant above (Tokyo is 7h ahead of Berlin in July: CEST UTC+2 vs
    // UTC+9). Tests that need a specific bail branch override one helper's
    // return value, leaving the other two live — each test only renders
    // once, so a single overridden value is enough.
    tzDiffMinutes.mockReturnValue(420);
    tzOffsetLabel.mockReturnValue("UTC+9");
    time.mockReturnValue("19:00");
  });

  it("renders the local clock and lead when the zone differs", () => {
    timeZoneAt.mockReturnValue("Asia/Tokyo");
    render(<PlaceLocalTime lat={35.68} lng={139.69} />);

    expect(screen.getByText("19:00")).toBeInTheDocument();
    // The exact string — not just a substring match on the offset — also
    // catches formatLead picking "behind" instead of "ahead" for a positive
    // diff.
    expect(screen.getByText("UTC+9 · ahead")).toBeInTheDocument();
    // Goes through the user's time-format preference rather than a
    // hardcoded 24h formatter — the whole point of switching off
    // formatInTimeZone.
    expect(time).toHaveBeenCalledWith(expect.any(Date), { timeZone: "Asia/Tokyo" });
  });

  it("renders nothing when the zone's offset diff can't be resolved", () => {
    timeZoneAt.mockReturnValue("Asia/Tokyo");
    tzDiffMinutes.mockReturnValue(null);
    const { container } = render(<PlaceLocalTime lat={35.68} lng={139.69} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the offset label can't be resolved, and never calls the clock formatter", () => {
    timeZoneAt.mockReturnValue("Asia/Tokyo");
    tzOffsetLabel.mockReturnValue(null);
    const { container } = render(<PlaceLocalTime lat={35.68} lng={139.69} />);

    expect(container.firstChild).toBeNull();
    // The label is the validity gate ahead of `fmt.time`, which throws
    // (rather than degrading) for a zone id the platform doesn't recognise —
    // it must never be reached once the label has failed to resolve.
    expect(time).not.toHaveBeenCalled();
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
    tzDiffMinutes.mockReturnValue(0);
    const { container } = render(<PlaceLocalTime lat={48.85} lng={2.35} />);

    expect(container.firstChild).toBeNull();
  });
});
