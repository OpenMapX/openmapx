import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { extractAge, OsmExtractDetails } from "./OsmExtractDetails";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

afterEach(cleanup);

describe("extractAge", () => {
  it("counts hours within two days, then days", () => {
    expect(extractAge(hoursAgo(0.5), NOW)).toBe("less than an hour ago");
    expect(extractAge(hoursAgo(5), NOW)).toBe("5 hours ago");
    expect(extractAge(hoursAgo(47), NOW)).toBe("47 hours ago");
    expect(extractAge(hoursAgo(48), NOW)).toBe("2 days ago");
    expect(extractAge(hoursAgo(24 * 40), NOW)).toBe("40 days ago");
  });

  it("does not report a future time as negative age", () => {
    expect(extractAge(hoursAgo(-3), NOW)).toBe("less than an hour ago");
  });
});

describe("OsmExtractDetails", () => {
  it("shows when the data is current to, its age and the feed that continues it", () => {
    render(
      <OsmExtractDetails
        now={NOW}
        extract={{
          timestamp: hoursAgo(20),
          replicationUrl: "https://download.geofabrik.de/europe/germany/berlin-updates",
        }}
      />,
    );
    expect(screen.getByText("Data as of")).toBeTruthy();
    expect(screen.getByText(/20 hours ago/)).toBeTruthy();
    expect(
      screen.getByText("https://download.geofabrik.de/europe/germany/berlin-updates"),
    ).toBeTruthy();
    expect(screen.queryByText(/Older than/)).toBeNull();
  });

  it("flags an extract older than thirty days", () => {
    render(<OsmExtractDetails now={NOW} extract={{ timestamp: hoursAgo(24 * 31) }} />);
    expect(screen.getByText("Older than 30 days")).toBeTruthy();
    expect(screen.queryByText(/Update feed/)).toBeNull();
  });

  it("says the time is unknown when the file records none", () => {
    render(<OsmExtractDetails now={NOW} extract={undefined} />);
    expect(screen.getByText("Unknown: the file records no replication time")).toBeTruthy();
  });
});
