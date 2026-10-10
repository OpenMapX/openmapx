import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/test";
import { TrafficLegend } from "./legend";
import { useTrafficStore } from "./store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const setVisible = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useOverlayVisibilitySetter: () => setVisible,
}));
afterEach(cleanup);
beforeEach(() => {
  useTrafficStore.setState({ panelOpen: true, layerVisible: true });
  setVisible.mockClear();
});
it("explains hosted map-only traffic without inferring age or coverage", async () => {
  const view = render(<TrafficLegend />);
  expect(screen.getByText("layers.trafficTomtom")).toBeDefined();
  expect(screen.queryByText("trafficStatus.overlay.hostedSource")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "trafficStatus.about" }));
  expect(screen.getByText("trafficStatus.overlay.hostedSource")).toBeDefined();
  expect(screen.getByRole("dialog")).toHaveTextContent("trafficStatus.overlay.ageUnknown");
  expect(screen.getByRole("dialog")).toHaveTextContent("trafficStatus.overlay.coverageUnknown");
  expect(screen.getByText("trafficStatus.overlay.mapOnly")).toBeDefined();
  expect(view.container.querySelector("button button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "common.close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("switch", { name: "trafficStatus.overlay.toggleHosted" }));
  expect(setVisible).toHaveBeenCalledWith(false);
});
it("renders hidden status only when panel is open", () => {
  useTrafficStore.setState({ layerVisible: false });
  const view = render(<TrafficLegend />);
  expect(screen.getByText("layers.trafficTomtom")).toBeDefined();
  expect(screen.getByText("trafficStatus.overlay.hidden")).toBeDefined();
  useTrafficStore.setState({ panelOpen: false });
  view.rerender(<TrafficLegend />);
  expect(screen.queryByText("trafficStatus.overlay.hostedSource")).toBeNull();
});
