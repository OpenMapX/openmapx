import { PANEL, useDirectionsStore, useSidebarStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

const state = vi.hoisted(() => ({
  saveHere: vi.fn(async () => "saved" as const),
  address: "Am Kuhteich 42",
}));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useReverseGeocoding: () => ({ data: { address: state.address }, isLoading: false }),
}));

vi.mock("./parking/useSaveParking", () => ({
  useSaveParking: () => ({ saveHere: state.saveHere, saveAt: vi.fn(), isSaving: false }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { MyLocationCard } from "./MyLocationCard";

beforeEach(() => {
  state.saveHere.mockClear();
  state.saveHere.mockResolvedValue("saved" as const);
  state.address = "Am Kuhteich 42";
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null });
});

describe("MyLocationCard", () => {
  it("shows the reverse-geocoded address", () => {
    render(<MyLocationCard coords={[6.6, 51.55]} onClose={() => {}} />);
    expect(screen.getByText("Am Kuhteich 42")).toBeInTheDocument();
  });

  it("falls back to coordinates when no address is known", () => {
    state.address = "";
    render(<MyLocationCard coords={[6.6, 51.55]} onClose={() => {}} />);
    expect(screen.getByText("51.550000, 6.600000")).toBeInTheDocument();
  });

  it("saves parking through the shared action and closes", async () => {
    const onClose = vi.fn();
    render(<MyLocationCard coords={[6.6, 51.55]} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /parking.saveParking/ }));
    await waitFor(() => expect(state.saveHere).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the card open and warns when the fix is unavailable", async () => {
    state.saveHere.mockResolvedValue("unavailable" as never);
    const onClose = vi.fn();
    render(<MyLocationCard coords={[6.6, 51.55]} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /parking.saveParking/ }));
    await waitFor(() =>
      expect(screen.getByText("parking.locationUnavailable")).toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("seeds the directions origin and opens the panel", async () => {
    render(<MyLocationCard coords={[6.6, 51.55]} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /parking.directionsFromHere/ }));
    expect(useDirectionsStore.getState().waypoints[0].coords).toEqual([6.6, 51.55]);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
  });
});
