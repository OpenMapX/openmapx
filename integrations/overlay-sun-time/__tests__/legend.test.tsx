import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";
import { useSunTimeStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// `t(key)` under the mock returns "sunTime.<key>", so the assertions below
// read against stable keys rather than copies of the message catalog.
import SunTimeLegend from "../legend";

describe("SunTimeLegend", () => {
  beforeEach(() => {
    useSunTimeStore.setState({
      panelOpen: true,
      layerVisible: true,
      showTerminator: true,
      showTimeZones: false,
      timeMs: null,
    });
  });

  it("renders nothing when the panel is closed", () => {
    useSunTimeStore.setState({ panelOpen: false });
    const { container } = render(<SunTimeLegend />);
    expect(container).toBeEmptyDOMElement();
  });

  it("pins the instant when the time slider moves", () => {
    render(<SunTimeLegend />);
    fireEvent.change(screen.getByLabelText("sunTime.time"), { target: { value: "540" } });
    expect(useSunTimeStore.getState().timeMs).not.toBeNull();
  });

  it("returns to the wall clock when Now is pressed", () => {
    useSunTimeStore.setState({ timeMs: 1_800_000_000_000 });
    render(<SunTimeLegend />);
    fireEvent.click(screen.getByRole("button", { name: "sunTime.now" }));
    expect(useSunTimeStore.getState().timeMs).toBeNull();
  });

  it("toggles the time zone sub-layer", () => {
    render(<SunTimeLegend />);
    fireEvent.click(screen.getByLabelText("sunTime.timeZones"));
    expect(useSunTimeStore.getState().showTimeZones).toBe(true);
  });
});
